const { v4: uuidv4 } = require("uuid");
const { getCommonConfig } = require("../../shared/config/env");
const { DatabaseEventStore } = require("../../shared/idempotency/eventStore");
const { startConsumerService } = require("../../shared/rabbitmq/consumerService");
const { RoutingKeys, EventTypes } = require("../../shared/rabbitmq/topology");
const { writeEventToOutbox } = require("../../shared/saga/outbox");
const { pool } = require("../config/db");
const { parseNumber } = require("../../shared/utils/parseNumber");

function shouldFail(failureRate) {
  return Math.random() < failureRate;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    routingKeys: [RoutingKeys.ORDER_CREATED, RoutingKeys.PAYMENT_REFUND_REQUESTED],
    processEvent: async (event, context) => {
      const { logger } = context;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Check routing key to determine action
        const routingKey = event.routingKey || RoutingKeys.ORDER_CREATED;

        if (routingKey === RoutingKeys.ORDER_CREATED) {
          await handleOrderCreated(event, client, logger, failureRate, processingMs);
        } else if (routingKey === RoutingKeys.PAYMENT_REFUND_REQUESTED) {
          await handleRefundRequested(event, client, logger, processingMs);
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

async function handleOrderCreated(event, client, logger, failureRate, processingMs) {
  logger.info("Processing payment for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    amount: event.payload.amount,
    currency: event.payload.currency,
  });

  // Record payment attempt in local state
  const paymentId = uuidv4();
  await client.query(
    `INSERT INTO payment_transactions (id, saga_id, order_id, status, amount, currency) 
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      paymentId,
      event.sagaId,
      event.orderId,
      "pending",
      event.payload.amount,
      event.payload.currency,
    ]
  );

  // Simulate payment processing
  await sleep(processingMs);

  if (shouldFail(failureRate)) {
    // Payment failed — commit the failure so the outbox event is published
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
        reason: "Simulated payment gateway failure",
      },
    });

    logger.info("Payment failed, written to outbox", {
      sagaId: event.sagaId,
      paymentId,
    });

    return;
  }

  // Payment succeeded
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

async function handleRefundRequested(event, client, logger, processingMs) {
  logger.info("Processing refund for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    amount: event.payload.amount,
    reason: event.payload.reason,
  });

  // Find the original payment
  const paymentResult = await client.query(
    "SELECT * FROM payment_transactions WHERE saga_id = $1 AND status = $2",
    [event.sagaId, "completed"]
  );

  if (paymentResult.rowCount === 0) {
    throw new Error(`No completed payment found for saga ${event.sagaId}`);
  }

  const payment = paymentResult.rows[0];

  // Update payment status to refunding
  await client.query(
    "UPDATE payment_transactions SET status = $1 WHERE id = $2",
    ["refunding", payment.id]
  );

  // Simulate refund processing
  await sleep(processingMs);

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
