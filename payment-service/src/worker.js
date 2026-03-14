const { v4: uuidv4 } = require("uuid");
const { getCommonConfig } = require("../../shared/config/env");
const { DatabaseEventStore } = require("../../shared/idempotency/eventStore");
const { startConsumerService } = require("../../shared/rabbitmq/consumerService");
const { RoutingKeys, EventTypes } = require("../../shared/rabbitmq/topology");
const { writeEventToOutbox } = require("../../shared/saga/outbox");
const { pool } = require("../config/db");
const { parseNumber } = require("../../shared/utils/parseNumber");



async function startWorker(logger) {
  const common = getCommonConfig("payment-service");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  const queueNames = {
    main: process.env.PAYMENT_QUEUE || "payment_queue",
    retry: process.env.PAYMENT_RETRY_QUEUE || "payment_retry_queue",
    dlq: process.env.PAYMENT_DLQ || "payment_dlq",
  };

  const failureRate = Math.max(
    0,
    Math.min(1, Number(process.env.PAYMENT_FAILURE_RATE || 0.3))
  );
  const processingMs = parseNumber(process.env.PAYMENT_PROCESSING_MS, 600);
  const eventStore = new DatabaseEventStore(common.serviceName, pool);

  logger.info("Payment worker configuration loaded", {
    queueNames,
    failureRate,
    processingMs,
    exchangeName,
  });

  return startConsumerService({
    serviceName: common.serviceName,
    logger,
    rabbitmqUrl: common.rabbitmqUrl,
    exchangeName,
    queueNames,
    retryDelayMs: common.retryDelayMs,
    prefetchCount: common.prefetchCount,
    maxRetries: common.maxRetries,
    eventStore,
    routingKeys: [
      RoutingKeys.ORDER_CREATED,
      RoutingKeys.ORDER_CANCELLED,
      RoutingKeys.PAYMENT_REFUND_REQUESTED,
    ],
    processEvent: async (event, context) => {
      const { logger } = context;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Check routing key to determine action
        const routingKey = event.routingKey || RoutingKeys.ORDER_CREATED;

        if (routingKey === RoutingKeys.ORDER_CREATED) {
          await handleOrderCreated(event, client, logger);
        } else if (
          routingKey === RoutingKeys.ORDER_CANCELLED ||
          routingKey === RoutingKeys.PAYMENT_REFUND_REQUESTED
        ) {
          await handleCancellationOrRefund(event, client, logger);
        } else {
          throw new Error(`Unknown routing key: ${routingKey}`);
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

async function handleOrderCreated(event, client, logger) {
  const customerId = event.payload.customerId;

  logger.info("Processing payment for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    amount: event.payload.amount,
    currency: event.payload.currency,
    customerId,
  });

  const existing = await client.query("SELECT id FROM payment_transactions WHERE saga_id = $1", [event.sagaId]);
  if (existing.rowCount > 0) {
    logger.info("Payment saga already processed or cancelled, ignoring order created", { sagaId: event.sagaId });
    return;
  }

  // Record payment attempt in local state
  const paymentId = uuidv4();
  await client.query(
    `INSERT INTO payment_transactions (id, saga_id, order_id, status, amount, currency, customer_id) 
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      paymentId,
      event.sagaId,
      event.orderId,
      "pending",
      event.payload.amount,
      event.payload.currency,
      customerId,
    ]
  );

  let success = true;
  let reason = "";

  const res = await client.query(
    "SELECT balance FROM customer_wallets WHERE customer_id = $1 FOR UPDATE",
    [customerId]
  );

  if (res.rows.length === 0) {
    success = false;
    reason = `Customer wallet not found: ${customerId}`;
  } else {
    const balance = parseFloat(res.rows[0].balance);
    const amount = parseFloat(event.payload.amount);

    if (balance < amount) {
      success = false;
      reason = "Insufficient funds";
    }
  }

  if (!success) {
    await client.query(
      "UPDATE payment_transactions SET status = $1, processed_at = NOW() WHERE id = $2",
      ["failed", paymentId]
    );

    // Write PaymentFailed to outbox
    await writeEventToOutbox(client, {
      type: EventTypes.PAYMENT_FAILED,
      sagaId: event.sagaId,
      correlationId: event.correlationId,
      orderId: event.orderId,
      payload: {
        paymentId,
        amount: event.payload.amount,
        currency: event.payload.currency,
        customerEmail: event.payload.customerEmail,
        reason,
      },
    });

    logger.info("Payment failed, written to outbox", {
      sagaId: event.sagaId,
      paymentId,
      reason,
    });

    return;
  }

  // Payment succeeded
  await client.query(
    "UPDATE customer_wallets SET balance = balance - $1, updated_at = NOW() WHERE customer_id = $2",
    [event.payload.amount, customerId]
  );

  await client.query(
    "UPDATE payment_transactions SET status = $1, processed_at = NOW() WHERE id = $2",
    ["completed", paymentId]
  );

  // Write PaymentCompleted to outbox
  await writeEventToOutbox(client, {
    type: EventTypes.PAYMENT_COMPLETED,
    sagaId: event.sagaId,
    correlationId: event.correlationId,
    orderId: event.orderId,
    payload: {
      paymentId,
      amount: event.payload.amount,
      currency: event.payload.currency,
      customerEmail: event.payload.customerEmail,
      items: event.payload.items,
    },
  });

  logger.info("Payment completed, written to outbox", {
    sagaId: event.sagaId,
    paymentId,
  });
}

async function handleCancellationOrRefund(event, client, logger) {
  logger.info("Processing cancellation/refund for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    reason: event.payload.reason,
  });

  // Find the original payment
  const paymentResult = await client.query(
    "SELECT * FROM payment_transactions WHERE saga_id = $1 FOR UPDATE",
    [event.sagaId]
  );

  if (paymentResult.rowCount === 0) {
    // Payment hasn't processed. Insert an early cancel record so handleOrderCreated ignores it.
    await client.query(
      `INSERT INTO payment_transactions (id, saga_id, order_id, status, amount, currency) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), event.sagaId, event.orderId, "cancelled", 0, "USD"]
    );
    return;
  }

  const payment = paymentResult.rows[0];
  if (payment.status !== "completed") {
    // It failed, is pending, or is already cancelled/refunded.
    return;
  }

  // Update payment status to refunding
  await client.query(
    "UPDATE payment_transactions SET status = $1 WHERE id = $2",
    ["refunding", payment.id]
  );

  // Add funds back to wallet
  if (payment.customer_id) {
    await client.query(
      "UPDATE customer_wallets SET balance = balance + $1, updated_at = NOW() WHERE customer_id = $2",
      [payment.amount, payment.customer_id]
    );
  }

  // Update payment status to refunded
  await client.query(
    "UPDATE payment_transactions SET status = $1, refunded_at = NOW() WHERE id = $2",
    ["refunded", payment.id]
  );

  // Write PaymentRefunded to outbox
  await writeEventToOutbox(client, {
    type: EventTypes.PAYMENT_REFUNDED,
    sagaId: event.sagaId,
    correlationId: event.correlationId,
    orderId: event.orderId,
    payload: {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      customerEmail: event.payload.customerEmail,
      reason: event.payload.reason,
      refundedAt: new Date().toISOString(),
    },
  });

  logger.info("Payment refunded, written to outbox", {
    sagaId: event.sagaId,
    paymentId: payment.id,
  });
}

module.exports = {
  startWorker,
};
