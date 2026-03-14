const express = require("express");
const { v4: uuidv4, validate: uuidValidate } = require("uuid");

const { getCommonConfig } = require("../../shared/config/env");
const { closeConnection } = require("../../shared/rabbitmq/connection");
const { pool } = require("../config/db");
const { writeEventToOutbox } = require("../../shared/saga/outbox");
const { SagaStateManager } = require("../../shared/saga/sagaState");
const { EventTypes } = require("../../shared/rabbitmq/topology");
const { parseNumber } = require("../../shared/utils/parseNumber");

const SAGA_TIMEOUT_MS = parseNumber(process.env.SAGA_TIMEOUT_MS, 90000);

async function startServer(logger) {
  const app = express();
  app.use(express.json());

  const config = getCommonConfig("order-service");
  const port = Number(process.env.PORT || 3000);

  // Initialize saga components
  const sagaManager = new SagaStateManager(pool);

  // Health check endpoint
  app.get("/health", (_, res) => {
    res.status(200).json({
      status: "ok",
      service: config.serviceName,
      timestamp: new Date().toISOString(),
    });
  });

  // Create order endpoint
  app.post("/orders", async (req, res) => {
    const client = await pool.connect();

    try {
      const orderId = uuidv4();
      const sagaId = uuidv4();
      // Prefer upstream trace ID; otherwise create one for this request lifecycle.
      const requestCorrelationId = req.get("x-correlation-id");
      const correlationId =
        requestCorrelationId && uuidValidate(requestCorrelationId)
          ? requestCorrelationId
          : uuidv4();

      const { customerId, customerEmail, items, amount, currency = "USD" } = req.body;

      await client.query("BEGIN");

      // Insert order
      await client.query(
        "INSERT INTO orders (id, items, customer_id, customer_email, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          orderId,
          JSON.stringify(items || []),
          customerId,
          customerEmail,
          amount,
          currency,
        ]
      );

      // Create saga instance
      await sagaManager.createSaga(sagaId, orderId, SAGA_TIMEOUT_MS);

      // Write OrderCreated event to outbox
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
      logger.error("Failed to create order", {
        error: error.message,
      });
      res.status(500).json({
        status: "error",
        message: error.message,
      });
    } finally {
      client.release();
    }
  });

  // Get saga status endpoint
  app.get("/sagas/:sagaId", async (req, res) => {
    try {
      const saga = await sagaManager.getSaga(req.params.sagaId);
      if (!saga) {
        return res.status(404).json({
          status: "error",
          message: "Saga not found",
        });
      }
      res.json({
        status: "ok",
        saga,
      });
    } catch (error) {
      logger.error("Failed to get saga", {
        sagaId: req.params.sagaId,
        error: error.message,
      });
      res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  });

  // Get customer orders endpoint
  app.get("/orders/customer/:customerId", async (req, res) => {
    try {
      const query = `
        SELECT o.id as order_id, o.items, o.amount, o.currency, o.created_at, s.status as saga_status, s.current_step
        FROM orders o
        LEFT JOIN saga_instances s ON o.id = s.order_id
        WHERE o.customer_id = $1
        ORDER BY o.created_at DESC
      `;
      const result = await pool.query(query, [req.params.customerId]);

      res.json({
        status: "ok",
        orders: result.rows,
      });
    } catch (error) {
      logger.error("Failed to get customer orders", {
        customerId: req.params.customerId,
        error: error.message,
      });
      res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  });

  // Manual refund endpoint
  app.post("/orders/:id/refund", async (req, res) => {
    const client = await pool.connect();
    try {
      const orderId = req.params.id;
      const { reason = "Customer requested manual refund" } = req.body;

      await client.query("BEGIN");

      // Verify order and saga
      const result = await client.query(
        "SELECT o.*, s.saga_id, s.status as saga_status FROM orders o JOIN saga_instances s ON o.id = s.order_id WHERE o.id = $1 FOR UPDATE",
        [orderId]
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ status: "error", message: "Order not found" });
      }

      const order = result.rows[0];

      if (order.saga_status !== "confirmed") {
        await client.query("ROLLBACK");
        return res.status(400).json({ status: "error", message: `Cannot refund order in status: ${order.saga_status}` });
      }

      // Update saga status to refunding
      await sagaManager.updateSagaStatus(order.saga_id, "refunding");

      const correlationId = uuidv4();

      // Write PaymentRefundRequested to outbox
      await writeEventToOutbox(client, {
        type: EventTypes.PAYMENT_REFUND_REQUESTED,
        sagaId: order.saga_id,
        correlationId: correlationId,
        orderId: order.id,
        payload: {
          amount: order.amount,
          currency: order.currency,
          customerEmail: order.customer_email,
          reason,
        },
      });

      await client.query("COMMIT");

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
      logger.error("Failed to request manual refund", {
        orderId: req.params.id,
        error: error.message,
      });
      res.status(500).json({
        status: "error",
        message: error.message,
      });
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

module.exports = {
  startServer,
};
