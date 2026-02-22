const express = require("express");
const { v4: uuidv4, validate: uuidValidate } = require("uuid");

const { getCommonConfig } = require("../../shared/config/env");
const { createChannel, closeConnection } = require("../../shared/rabbitmq/connection");
const { pool } = require("../config/db");
const { writeEventToOutbox } = require("../../shared/saga/outbox");
const { SagaStateManager } = require("../../shared/saga/sagaState");
const { SagaHandler } = require("./sagaHandler");
const { RoutingKeys, EventTypes } = require("../../shared/rabbitmq/topology");
const { parseNumber } = require("../../shared/utils/parseNumber");

const SAGA_TIMEOUT_MS = parseNumber(process.env.SAGA_TIMEOUT_MS, 90000);

async function startServer(logger) {
  const app = express();
  app.use(express.json());

  const config = getCommonConfig("order-service");
  const port = Number(process.env.PORT || 3000);
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  // Initialize saga components
  const sagaManager = new SagaStateManager(pool);
  const sagaHandler = new SagaHandler(pool, sagaManager, logger);

  // Create RabbitMQ channel for consumers
  const channel = await createChannel({
    rabbitmqUrl: config.rabbitmqUrl,
    logger,
    serviceName: config.serviceName,
  });

  // Setup consumer queues for saga events
  const consumerQueue = "order_service_queue";
  const retryQueue = "order_service_retry_queue";
  const dlqQueue = "order_service_dlq";
  const retryDelayMs = parseNumber(process.env.RETRY_DELAY_MS, 5000);

  // Assert queues
  await channel.assertQueue(consumerQueue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": retryQueue,
    },
  });

  await channel.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": consumerQueue,
    },
  });

  await channel.assertQueue(dlqQueue, { durable: true });

  // Assert topic exchange
  await channel.assertExchange(exchangeName, "topic", { durable: true });

  // Bind to saga event routing keys
  const routingKeys = [
    RoutingKeys.PAYMENT_COMPLETED,
    RoutingKeys.PAYMENT_FAILED,
    RoutingKeys.INVENTORY_RESERVED,
    RoutingKeys.INVENTORY_FAILED,
    RoutingKeys.PAYMENT_REFUNDED,
  ];

  for (const routingKey of routingKeys) {
    await channel.bindQueue(consumerQueue, exchangeName, routingKey);
  }

  await channel.prefetch(1);

  // Start consuming saga events
  channel.consume(
    consumerQueue,
    async (msg) => {
      if (!msg) return;

      try {
        const event = JSON.parse(msg.content.toString());
        const routingKey = msg.fields.routingKey;

        logger.info("Received saga event", {
          eventId: event.eventId,
          sagaId: event.sagaId,
          routingKey,
        });

        // Route to appropriate handler based on routing key
        switch (routingKey) {
          case RoutingKeys.PAYMENT_COMPLETED:
            await sagaHandler.handlePaymentCompleted(event);
            break;
          case RoutingKeys.PAYMENT_FAILED:
            await sagaHandler.handlePaymentFailed(event);
            break;
          case RoutingKeys.INVENTORY_RESERVED:
            await sagaHandler.handleInventoryReserved(event);
            break;
          case RoutingKeys.INVENTORY_FAILED:
            await sagaHandler.handleInventoryFailed(event);
            break;
          case RoutingKeys.PAYMENT_REFUNDED:
            await sagaHandler.handlePaymentRefunded(event);
            break;
          default:
            logger.warn("Unknown routing key", { routingKey });
        }

        channel.ack(msg);
      } catch (error) {
        logger.error("Failed to process saga event", {
          error: error.message,
        });
        channel.nack(msg, false, false);
      }
    },
    { noAck: false }
  );

  logger.info("Order service saga consumer started", {
    queue: consumerQueue,
    routingKeys,
  });

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

  const server = app.listen(port, () => {
    logger.info("Order service HTTP server listening", { port });
  });

  const shutdown = async () => {
    logger.warn("Order service shutdown requested");
    server.close(async () => {
      await channel.close();
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
