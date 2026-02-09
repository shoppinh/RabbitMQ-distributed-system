const express = require("express");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const { getCommonConfig } = require("../../shared/config/env");
const {
  createChannel,
  closeConnection,
} = require("../../shared/rabbitmq/connection");
const { setupOrderPublisher } = require("../../shared/rabbitmq/topology");
const { publishJson } = require("../../shared/rabbitmq/message");
const { pool } = require("../../shared/config/db");

async function startServer(logger) {
  const app = express();
  app.use(express.json());

  const config = getCommonConfig("order-service");
  const port = Number(process.env.PORT || 3000);

  const channel = await createChannel({
    rabbitmqUrl: config.rabbitmqUrl,
    logger,
    serviceName: config.serviceName,
  });

  await setupOrderPublisher(channel, config.orderExchange);

  logger.info("Order publisher initialized", {
    exchange: config.orderExchange,
  });

  app.get("/health", (_, res) => {
    res.status(200).json({
      status: "ok",
      service: config.serviceName,
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/orders", async (req, res) => {
    try {
      const client = await pool.connect();
      const orderId = uuidv4();
      const eventId = uuidv4();

      const event = {
        eventId,
        orderId,
        timestamp: new Date().toISOString(),
        payload: {
          items: Array.isArray(req.body.items) ? req.body.items : [],
        },
      };

      try {
        await client.query("BEGIN");

        await client.query("INSERT INTO orders (id, items) VALUES ($1, $2)", [
          orderId,
          req.body.items,
        ]);

        await client.query(
          "INSERT INTO events (id, type, payload) VALUES ($1, $2, $3)",
          [eventId, "OrderCreated", event],
        );

        await client.query("COMMIT");
        logger.info("OrderCreated event published", {
          eventId,
          orderId,
        });
        res.status(201).json({
          status: "accepted",
          eventType: "OrderCreated",
          order: event,
        });
      } catch (dbError) {
        await client.query("ROLLBACK");
        res.status(500).json({
          status: "error",
          message: `Database error occurred : ${dbError.message}`,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error("Failed to publish OrderCreated event", {
        error: error.message,
      });

      res.status(500).json({
        status: "error",
        message: "Could not create order",
      });
    }
  });

  const server = app.listen(port, () => {
    logger.info("Order service listening", { port });
  });

  const shutdown = async () => {
    logger.warn("Order service shutdown requested");
    server.close(async () => {
      await channel.close();
      await closeConnection(logger, config.serviceName);
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  startServer,
};
