// inventory-service/src/worker.ts
import { v4 as uuidv4 } from "uuid";
import { getCommonConfig } from "../../shared/config/env";
import { DatabaseEventStore } from "../../shared/idempotency/eventStore";
import { startConsumerService, ConsumedEvent } from "../../shared/rabbitmq/consumerService";
import { RoutingKeys, EventTypes } from "../../shared/rabbitmq/topology";
import { writeEventToOutbox } from "../../shared/saga/outbox";
import { pool } from "../config/db";
import { parseNumber } from "../../shared/utils/parseNumber";
import type { Logger } from "../../shared/utils/logger";
import type { PoolClient } from "pg";

interface InventoryRow {
  sku: string;
  total_stock: number;
  reserved_stock: number;
  qty?: number;
}

interface ReservationRow {
  id: string;
  sku: string;
  qty: number;
  status: string;
}

export async function startWorker(logger: Logger): Promise<void> {
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

  await startConsumerService({
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

async function handleOrderCreated(
  event: ConsumedEvent,
  client: PoolClient,
  logger: Logger
): Promise<void> {
  logger.info("Reserving inventory for order", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    orderId: event.orderId,
    items: event.payload["items"],
  });

  const existing = await client.query(
    "SELECT id FROM inventory_reservations WHERE saga_id = $1",
    [event.sagaId]
  );
  if ((existing.rowCount ?? 0) > 0) {
    logger.info("Inventory saga already processed or cancelled, ignoring order created", {
      sagaId: event.sagaId,
    });
    return;
  }

  const items = (event.payload["items"] as Array<{ sku: string; qty: number }>) || [];
  let success = true;
  let failReason = "";

  // Sort items by SKU to prevent deadlocks
  const sortedItems = [...items].sort((a, b) => a.sku.localeCompare(b.sku));
  const skus = sortedItems.map((item) => item.sku);

  const res = await client.query<InventoryRow>(
    "SELECT sku, total_stock, reserved_stock FROM inventory WHERE sku = ANY($1) ORDER BY sku ASC FOR UPDATE",
    [skus]
  );

  if (res.rows.length === 0) {
    success = false;
    failReason = "No SKUs found";
  }

  if (res.rows.length !== skus.length) {
    success = false;
    failReason = `Some SKUs are not found`;
  }

  const inventoryMap: Record<string, InventoryRow> = Object.fromEntries(
    res.rows.map((r) => [r.sku, r])
  );

  for (const item of sortedItems) {
    const inv = inventoryMap[item.sku];
    if (!inv) {
      failReason = `SKU not found: ${item.sku}`;
      success = false;
      break;
    }
    if (inv.total_stock - inv.reserved_stock < item.qty) {
      failReason = `Insufficient stock: ${item.sku}`;
      success = false;
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

    logger.info("Inventory reservation failed, written to outbox", {
      sagaId: event.sagaId,
      reason: failReason,
    });

    return;
  }

  // Reserve inventory
  for (const item of sortedItems) {
    const reservationId = uuidv4();
    await client.query(
      "UPDATE inventory SET updated_at = NOW(), reserved_stock = reserved_stock + $1 WHERE sku = $2",
      [item.qty, item.sku]
    );
    await client.query(
      `INSERT INTO inventory_reservations (id, saga_id, order_id, sku, qty, status, reserved_at) 
       VALUES ($1, $2, $3, $4, $5, 'reserved', NOW())`,
      [reservationId, event.sagaId, event.orderId, item.sku, item.qty]
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

async function handleOrderCancelled(
  event: ConsumedEvent,
  client: PoolClient,
  logger: Logger
): Promise<void> {
  const existing = await client.query(
    "SELECT id FROM inventory_reservations WHERE saga_id = $1 FOR UPDATE",
    [event.sagaId]
  );
  if ((existing.rowCount ?? 0) === 0) {
    // Insert dummy record to protect against late ORDER_CREATED
    await client.query(
      `INSERT INTO inventory_reservations (id, saga_id, order_id, sku, qty, status) 
       VALUES ($1, $2, $3, $4, $5, 'released')`,
      [uuidv4(), event.sagaId, event.orderId, "N/A", 0]
    );
    return;
  }

  const res = await client.query<ReservationRow>(
    "SELECT id, sku, qty, status FROM inventory_reservations WHERE saga_id = $1 AND status = 'reserved' ORDER BY sku FOR UPDATE",
    [event.sagaId]
  );

  if (res.rows.length === 0) return;

  const skus = res.rows.map((r) => r.sku);

  await client.query(
    "SELECT sku FROM inventory WHERE sku = ANY($1) ORDER BY sku ASC FOR UPDATE",
    [skus]
  );

  for (const reservation of res.rows) {
    await client.query(
      "UPDATE inventory SET updated_at = NOW(), reserved_stock = reserved_stock - $1 WHERE sku = $2",
      [reservation.qty, reservation.sku]
    );

    await client.query(
      "UPDATE inventory_reservations SET status = 'released', release_at = NOW() WHERE id = $1",
      [reservation.id]
    );
  }

  logger.info("Inventory reservation released due to cancellation", {
    sagaId: event.sagaId,
  });
}

async function handleOrderConfirmed(
  event: ConsumedEvent,
  client: PoolClient,
  logger: Logger
): Promise<void> {
  const res = await client.query<ReservationRow>(
    "SELECT id, sku, qty, status FROM inventory_reservations WHERE saga_id = $1 AND status = 'reserved' ORDER BY sku FOR UPDATE",
    [event.sagaId]
  );

  if (res.rows.length === 0) return;

  const skus = res.rows.map((r) => r.sku);

  await client.query(
    "SELECT sku FROM inventory WHERE sku = ANY($1) ORDER BY sku ASC FOR UPDATE",
    [skus]
  );

  for (const reservation of res.rows) {
    await client.query(
      "UPDATE inventory SET updated_at = NOW(), total_stock = total_stock - $1, reserved_stock = reserved_stock - $1 WHERE sku = $2",
      [reservation.qty, reservation.sku]
    );

    await client.query(
      "UPDATE inventory_reservations SET status = 'committed', confirmed_at = NOW() WHERE id = $1",
      [reservation.id]
    );
  }

  logger.info("Inventory reservation committed", {
    sagaId: event.sagaId,
  });
}
