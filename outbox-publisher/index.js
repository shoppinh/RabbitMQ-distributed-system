const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { closeConnection } = require("../shared/rabbitmq/connection");
const { setupOutboxPublisher } = require("../shared/rabbitmq/topology");
const { getCommonConfig } = require("../shared/config/env");
const { createChannel } = require("../shared/rabbitmq/channel");
const { pool } = require("../shared/database/pool");
const { publishJson } = require("../shared/rabbitmq/message");

const serviceName = "inventory-service";
const logger = createLogger(serviceName);

async function init() {
  const config = getCommonConfig("outbox-publisher");
  const channel = await createChannel({
    rabbitmqUrl: config.rabbitmqUrl,
    logger,
    serviceName: config.serviceName,
  });
  const shutdown = async () => {
    logger.warn("Outbox service shutdown requested");
    await channel.close();
    await closeConnection(logger, config.serviceName);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await setupOutboxPublisher(channel, config.orderExchange);
  logger.info("Outbox publisher initialized", {
    exchange: config.orderExchange,
  });

  while (true) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM outbox_events
         WHERE published = false
         ORDER BY created_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED`,
      );

      for (const event of result.rows) {
        publishJson(channel, config.orderExchange, "", event, {
          messageId: event.id,
          type: "OrderCreated",
        });

        await client.query(
          "UPDATE outbox_events SET published = true WHERE id = $1",
          [event.id],
        );

        logger.info("Outbox event published", { eventId: event.id });
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error("Failed to start outbox publisher", {
        error: error.message,
      });
      process.exit(1);
    } finally {
      client.release();
    }
  }
}

init();
