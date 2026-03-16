// order-service/src/server.ts
import express, { Request, Response } from "express";
import { v4 as uuidv4, validate as uuidValidate } from "uuid";

import { getCommonConfig } from "../../shared/config/env";
import { closeConnection } from "../../shared/rabbitmq/connection";
import { pool } from "../config/db";
import { writeEventToOutbox } from "../../shared/saga/outbox";
import { SagaStateManager } from "../../shared/saga/sagaState";
import { EventTypes } from "../../shared/rabbitmq/topology";
import { parseNumber } from "../../shared/utils/parseNumber";
import type { Logger } from "../../shared/utils/logger";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  CacheKeys,
  CacheTTL,
} from "../../shared/cache/redisCache";

const SAGA_TIMEOUT_MS = parseNumber(process.env.SAGA_TIMEOUT_MS, 90000);

interface OrderRow {
  order_id: string;
  items: unknown;
  amount: number;
  currency: string;
  created_at: Date;
  saga_status: string;
  current_step: string;
}

export async function startServer(logger: Logger): Promise<void> {
  const app = express();
  app.use(express.json());

  const config = getCommonConfig("order-service");
  const port = Number(process.env.PORT || 3000);

  const sagaManager = new SagaStateManager(pool);

  // ------------------------------------------------------------------
  // Health check
  // ------------------------------------------------------------------
  app.get("/health", (_: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      service: config.serviceName,
      timestamp: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------------
  // Create order
  // ------------------------------------------------------------------
  app.post("/orders", async (req: Request, res: Response) => {
    const client = await pool.connect();

    try {
      const orderId = uuidv4();
      const sagaId = uuidv4();
      const requestCorrelationId = req.get("x-correlation-id");
      const correlationId =
        requestCorrelationId && uuidValidate(requestCorrelationId)
          ? requestCorrelationId
          : uuidv4();

      const { customerId, customerEmail, items, amount, currency = "USD" } =
        req.body as {
          customerId: string;
          customerEmail: string;
          items: Array<{ sku: string; qty: number }>;
          amount: number;
          currency?: string;
        };

      await client.query("BEGIN");

      await client.query(
        "INSERT INTO orders (id, items, customer_id, customer_email, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)",
        [orderId, JSON.stringify(items || []), customerId, customerEmail, amount, currency]
      );

      await sagaManager.createSaga(sagaId, orderId, SAGA_TIMEOUT_MS);

      await writeEventToOutbox(client, {
        type: EventTypes.ORDER_CREATED,
        sagaId,
        correlationId,
        orderId,
        payload: {
          customerId,
          customerEmail,
          items: items || [],
          amount,
          currency,
        },
      });

      await client.query("COMMIT");

      // Invalidate customer orders cache since we have a new order
      await cacheDelete(CacheKeys.customerOrders(customerId), logger);

      logger.info("Order created and saga started", {
        orderId,
        sagaId,
        correlationId,
        customerId,
      });

      res.status(201).json({
        status: "accepted",
        orderId,
        sagaId,
        correlationId,
        message: "Order created, saga started",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const err = error as Error;
      logger.error("Failed to create order", { error: err.message });
      res.status(500).json({ status: "error", message: err.message });
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // Get saga status (with short-lived cache)
  // ------------------------------------------------------------------
  app.get("/sagas/:sagaId", async (req: Request, res: Response) => {
    const sagaId = String(req.params["sagaId"]);
    try {
      const cacheKey = CacheKeys.sagaStatus(sagaId);
      const cached = await cacheGet<unknown>(cacheKey, logger);
      if (cached) {
        return res.json({ status: "ok", saga: cached, source: "cache" });
      }

      const saga = await sagaManager.getSaga(sagaId);
      if (!saga) {
        return res.status(404).json({ status: "error", message: "Saga not found" });
      }

      // Only cache terminal states; pending states change rapidly
      if (saga.status !== "pending") {
        await cacheSet(cacheKey, saga, CacheTTL.SAGA_STATUS, logger);
      }

      res.json({ status: "ok", saga });
    } catch (error) {
      const err = error as Error;
      logger.error("Failed to get saga", { sagaId, error: err.message });
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // ------------------------------------------------------------------
  // Get customer orders (with cache)
  // ------------------------------------------------------------------
  app.get("/orders/customer/:customerId", async (req: Request, res: Response) => {
    const customerId = String(req.params["customerId"]);
    try {
      const cacheKey = CacheKeys.customerOrders(customerId);
      const cached = await cacheGet<OrderRow[]>(cacheKey, logger);
      if (cached) {
        return res.json({ status: "ok", orders: cached, source: "cache" });
      }

      const query = `
        SELECT o.id as order_id, o.items, o.amount, o.currency, o.created_at, s.status as saga_status, s.current_step
        FROM orders o
        LEFT JOIN saga_instances s ON o.id = s.order_id
        WHERE o.customer_id = $1
        ORDER BY o.created_at DESC
      `;
      const result = await pool.query<OrderRow>(query, [customerId]);

      await cacheSet(cacheKey, result.rows, CacheTTL.CUSTOMER_ORDERS, logger);

      res.json({ status: "ok", orders: result.rows });
    } catch (error) {
      const err = error as Error;
      logger.error("Failed to get customer orders", {
        customerId,
        error: err.message,
      });
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // ------------------------------------------------------------------
  // Manual refund
  // ------------------------------------------------------------------
  app.post("/orders/:id/refund", async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const orderId = req.params.id;
      const { reason = "Customer requested manual refund" } = req.body as {
        reason?: string;
      };

      await client.query("BEGIN");

      const result = await client.query(
        "SELECT o.*, s.saga_id, s.status as saga_status FROM orders o JOIN saga_instances s ON o.id = s.order_id WHERE o.id = $1 FOR UPDATE",
        [orderId]
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ status: "error", message: "Order not found" });
      }

      const order = result.rows[0] as {
        id: string;
        saga_id: string;
        saga_status: string;
        amount: number;
        currency: string;
        customer_email: string;
        customer_id: string;
      };

      if (order.saga_status !== "confirmed") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: "error",
          message: `Cannot refund order in status: ${order.saga_status}`,
        });
      }

      await sagaManager.updateSagaStatus(order.saga_id, "refunding");

      const correlationId = uuidv4();

      await writeEventToOutbox(client, {
        type: EventTypes.PAYMENT_REFUND_REQUESTED,
        sagaId: order.saga_id,
        correlationId,
        orderId: order.id,
        payload: {
          amount: order.amount,
          currency: order.currency,
          customerEmail: order.customer_email,
          reason,
        },
      });

      await client.query("COMMIT");

      // Invalidate cache after status change
      await cacheDelete(CacheKeys.customerOrders(order.customer_id), logger);
      await cacheDelete(CacheKeys.sagaStatus(order.saga_id), logger);

      logger.info("Manual refund requested", {
        orderId,
        sagaId: order.saga_id,
        reason,
      });

      res.status(202).json({
        status: "accepted",
        message: "Refund requested successfully",
        orderId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const err = error as Error;
      logger.error("Failed to request manual refund", {
        orderId: req.params.id,
        error: err.message,
      });
      res.status(500).json({ status: "error", message: err.message });
    } finally {
      client.release();
    }
  });

  const server = app.listen(port, () => {
    logger.info("Order service HTTP server listening", { port });
  });

  const shutdown = async () => {
    logger.warn("Order service shutdown requested");
    server.close(async () => {
      await closeConnection(logger, config.serviceName);
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
