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
  const common = getCommonConfig("inventory-service");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  const queueNames = {
    main: process.env.INVENTORY_QUEUE || "inventory_queue",
    retry: process.env.INVENTORY_RETRY_QUEUE || "inventory_retry_queue",
    dlq: process.env.INVENTORY_DLQ || "inventory_dlq",
  };

  const failureRate = Math.max(
    0,
    Math.min(1, Number(process.env.INVENTORY_FAILURE_RATE || 0.2))
  );
  const processingMs = parseNumber(process.env.INVENTORY_PROCESSING_MS, 300);
  const eventStore = new DatabaseEventStore(common.serviceName, pool);

  logger.info("Inventory worker configuration loaded", {
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
    routingKeys: [RoutingKeys.PAYMENT_COMPLETED],
    processEvent: async (event, context) => {
      const { logger } = context;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await handlePaymentCompleted(event, client, logger, failureRate, processingMs);

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

async function handlePaymentCompleted(event, client, logger, failureRate, processingMs) {
  logger.info("Reserving inventory for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    items: event.payload.items,
  });

  // Record inventory reservation attempt
  const reservationId = uuidv4();
  await client.query(
    `INSERT INTO inventory_reservations (id, saga_id, order_id, status, items) 
     VALUES ($1, $2, $3, $4, $5)`,
    [
      reservationId,
      event.sagaId,
      event.orderId,
      "pending",
      JSON.stringify(event.payload.items || []),
    ]
  );

  // Simulate inventory processing
  await sleep(processingMs);

  if (shouldFail(failureRate)) {
    // Inventory reservation failed — commit the failure so the outbox event is published
    await client.query(
      "UPDATE inventory_reservations SET status = $1 WHERE id = $2",
      ["failed", reservationId]
    );

    // Write InventoryFailed to outbox
    await writeEventToOutbox(client, {
      type: EventTypes.INVENTORY_FAILED,
      sagaId: event.sagaId,
      orderId: event.orderId,
      payload: {
        reservationId,
        items: event.payload.items,
        amount: event.payload.amount,
        currency: event.payload.currency,
        customerEmail: event.payload.customerEmail,
        reason: "Simulated inventory reservation failure",
      },
    });

    logger.info("Inventory reservation failed, written to outbox", {
      sagaId: event.sagaId,
      reservationId,
    });

    return;
  }

  // Inventory reserved successfully
  await client.query(
    "UPDATE inventory_reservations SET status = $1, reserved_at = NOW() WHERE id = $2",
    ["reserved", reservationId]
  );

  // Write InventoryReserved to outbox
  await writeEventToOutbox(client, {
    type: EventTypes.INVENTORY_RESERVED,
    sagaId: event.sagaId,
    orderId: event.orderId,
    payload: {
      reservationId,
      items: event.payload.items,
      amount: event.payload.amount,
      currency: event.payload.currency,
      customerEmail: event.payload.customerEmail,
    },
  });

  logger.info("Inventory reserved, written to outbox", {
    sagaId: event.sagaId,
    reservationId,
  });
}

module.exports = {
  startWorker,
};
