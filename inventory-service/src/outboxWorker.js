// Outbox Worker for Inventory Service
// Polls events table and publishes to RabbitMQ

const { createConfirmChannel, closeConnection } = require("../../shared/rabbitmq/connection");
const { publishOutboxEventConfirmed } = require("../../shared/rabbitmq/message");
const { getCommonConfig } = require("../../shared/config/env");
const { pool } = require("../config/db");
const { parseNumber } = require("../../shared/utils/parseNumber");

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000);
const BATCH_SIZE = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startOutboxWorker(logger) {
  const config = getCommonConfig("inventory-service-outbox");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  logger.info("Starting Inventory Service outbox worker", {
    exchange: exchangeName,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  const channel = await createConfirmChannel({
    rabbitmqUrl: config.rabbitmqUrl,
    logger,
    serviceName: config.serviceName,
  });

  const shutdown = async () => {
    logger.warn("Inventory service outbox worker shutdown requested");
    await channel.close();
    await closeConnection(logger, config.serviceName);
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (true) {
    const client = await pool.connect();
    let shouldSleep = false;

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT * FROM events
         WHERE published = false
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );

      if (result.rows.length === 0) {
        shouldSleep = true;
      }

      for (const event of result.rows) {
        try {
          await publishOutboxEventConfirmed(channel, exchangeName, event);

          await client.query(
            "UPDATE events SET published = true, published_at = NOW() WHERE id = $1",
            [event.id]
          );

          logger.info("Inventory outbox event published", {
            eventId: event.id,
            type: event.type,
            routingKey: event.routing_key,
          });
        } catch (publishError) {
          logger.error("Failed to publish outbox event", {
            eventId: event.id,
            error: publishError.message,
          });
          throw publishError;
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error("Inventory outbox publish loop failed; retrying", {
        error: error.message,
      });
      shouldSleep = true;
    } finally {
      client.release();
    }

    if (shouldSleep) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

module.exports = {
  startOutboxWorker,
};
