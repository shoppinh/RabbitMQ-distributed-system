const { v4: uuidv4 } = require("uuid");
const { getCommonConfig } = require("../../shared/config/env");
const { DatabaseEventStore } = require("../../shared/idempotency/eventStore");
const {
  startConsumerService,
} = require("../../shared/rabbitmq/consumerService");
const { RoutingKeys, EventTypes } = require("../../shared/rabbitmq/topology");
const { writeEventToOutbox } = require("../../shared/saga/outbox");
const { pool } = require("../config/db");
const { parseNumber } = require("../../shared/utils/parseNumber");

// Replaced simulate sleep and failure with actual stock check logic

async function startWorker(logger) {
  const common = getCommonConfig("inventory-service");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  const queueNames = {
    main: process.env.INVENTORY_QUEUE || "inventory_queue",
    retry: process.env.INVENTORY_RETRY_QUEUE || "inventory_retry_queue",
    dlq: process.env.INVENTORY_DLQ || "inventory_dlq",
  };

  const processingMs = parseNumber(process.env.INVENTORY_PROCESSING_MS, 300);
  const eventStore = new DatabaseEventStore(common.serviceName, pool);

  logger.info("Inventory worker configuration loaded", {
    queueNames,
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
      RoutingKeys.ORDER_CONFIRMED,
    ],
    processEvent: async (event, context) => {
      const { logger } = context;
      const client = await pool.connect();
      const routingKey = event.routingKey;

      try {
        await client.query("BEGIN");

        if (routingKey === RoutingKeys.ORDER_CREATED) {
          await handleOrderCreated(event, client, logger);
        } else if (routingKey === RoutingKeys.ORDER_CANCELLED) {
          await handleOrderCancelled(event, client, logger);
        } else if (routingKey === RoutingKeys.ORDER_CONFIRMED) {
          await handleOrderConfirmed(event, client, logger);
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
  logger.info("Reserving inventory for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    items: event.payload.items,
  });

  const items = event.payload.items || [];
  let success = true;
  let failReason = "";

  // Sort items by SKU to prevent deadlocks
  const sortedItems = [...items].sort((a, b) => a.sku.localeCompare(b.sku));
  const skus = sortedItems.map((item) => item.sku);

  // Lock all inventory items for this order
  const res = await client.query(
    "SELECT sku FROM inventory WHERE sku = ANY($1) ORDER BY sku ASC FOR UPDATE",
    [skus],
  );

  if (res.rows.length === 0) {
    success = false;
    failReason = "No SKUs found";
  }

  if (res.rows.length !== skus.length) {
    success = false;
    failReason = `Some SKUs are not found: ${skus.filter((sku) => !res.rows.includes(sku)).join(", ")}`;
  }

  const inventoryMap = Object.fromEntries(res.rows.map((r) => [r.sku, r]));
  for (const item of sortedItems) {
    const inv = inventoryMap[item.sku];
    if (!inv) {
      failReason = `SKU not found: ${item.sku}`;
      break;
    }
    if (inv.total_stock - inv.reserved_stock < item.qty) {
      failReason = `Insufficient stock: ${item.sku}`;
      break;
    }
  }

  if (!success) {
    await writeEventToOutbox(client, {
      type: EventTypes.INVENTORY_FAILED,
      sagaId: event.sagaId,
      correlationId: event.correlationId,
      orderId: event.orderId,
      payload: { ...event.payload, reason: failReason },
    });

    // Should we send payment refund requested event here or order service should send it?

    logger.info("Inventory reservation failed, written to outbox", {
      sagaId: event.sagaId,
      reason: failReason,
    });

    return;
  }

  // Reserve inventory
  for (const row of res.rows) {
    const reservationId = uuidv4();
    await client.query(
      "UPDATE inventory SET updated_at = NOW(), reserved_stock = reserved_stock + $1 WHERE sku = $2",
      [row.qty, row.sku],
    );
    await client.query(
      `INSERT INTO inventory_reservations (id, saga_id, order_id, sku, qty, status, reserved_at) 
       VALUES ($1, $2, $3, $4, $5, 'reserved', NOW())`,
      [reservationId, event.sagaId, event.orderId, row.sku, row.qty],
    );
  }

  await writeEventToOutbox(client, {
    type: EventTypes.INVENTORY_RESERVED,
    sagaId: event.sagaId,
    correlationId: event.correlationId,
    orderId: event.orderId,
    payload: event.payload,
  });

  logger.info("Inventory reserved, written to outbox", {
    sagaId: event.sagaId,
  });
}

async function handleOrderCancelled(event, client, logger) {
  // Find all reservations, group by sku and lock them
  const res = await client.query(
    "SELECT id, sku, qty, status FROM inventory_reservations WHERE saga_id = $1 AND status = 'reserved' ORDER BY sku FOR UPDATE ",
    [event.sagaId],
  );

  if (res.rows.length === 0) return;

  const skus = res.rows.map((r) => r.sku);

  // Lock all inventory items for this order
  await client.query(
    "SELECT sku FROM inventory WHERE sku = ANY($1) ORDER BY sku ASC FOR UPDATE",
    [skus],
  );

  for (const reservation of res.rows) {
    await client.query(
      "UPDATE inventory SET updated_at = NOW(), reserved_stock = reserved_stock - $1 WHERE sku = $2",
      [reservation.qty, reservation.sku],
    );

    await client.query(
      "UPDATE inventory_reservations SET status = 'released', release_at = NOW() WHERE id = $1",
      [reservation.id],
    );
  }

  logger.info("Inventory reservation released due to cancellation", {
    sagaId: event.sagaId,
  });
}

async function handleOrderConfirmed(event, client, logger) {
  // Find all reservations, group by sku and lock them
  const res = await client.query(
    "SELECT id, sku, qty, status FROM inventory_reservations WHERE saga_id = $1 AND status = 'reserved' ORDER BY sku FOR UPDATE",
    [event.sagaId],
  );

  if (res.rows.length === 0) return;

  const skus = res.rows.map((r) => r.sku);

  // Lock all inventory items for this order
  await client.query(
    "SELECT sku FROM inventory WHERE sku = ANY($1) ORDER BY sku ASC FOR UPDATE",
    [skus],
  );

  for (const reservation of res.rows) {
    // Deduct from total stock and free up reserved stock
    await client.query(
      "UPDATE inventory SET updated_at = NOW(), total_stock = total_stock - $1, reserved_stock = reserved_stock - $1 WHERE sku = $2",
      [reservation.qty, reservation.sku],
    );

    await client.query(
      "UPDATE inventory_reservations SET status = 'committed', confirmed_at = NOW() WHERE id = $1",
      [reservation.id],
    );
  }

  logger.info("Inventory reservation committed", {
    sagaId: event.sagaId,
  });
}

module.exports = {
  startWorker,
};
