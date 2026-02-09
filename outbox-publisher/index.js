const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { closeConnection } = require("../shared/rabbitmq/connection");
const { setupOutboxPublisher } = require("../shared/rabbitmq/topology");
const { getCommonConfig } = require("../shared/config/env");
const { createConfirmChannel } = require("../shared/rabbitmq/connection");
const { pool } = require("../shared/config/db");
const { publishJsonConfirmed } = require("../shared/rabbitmq/message");

const serviceName = "outbox-publisher";
const logger = createLogger(serviceName);
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  const config = getCommonConfig("outbox-publisher");
  const channel = await createConfirmChannel({
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
    let shouldSleep = false;

    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM events
         WHERE published = false
         ORDER BY created_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED`,
      );

      if (result.rows.length === 0) {
        shouldSleep = true;
      }

      for (const event of result.rows) {
        await publishJsonConfirmed(channel, config.orderExchange, "", event.payload, {
          messageId: event.id,
          type: "OrderCreated",
        });

        await client.query(
          "UPDATE events SET published = true, published_at = NOW() WHERE id = $1",
          [event.id],
        );

        logger.info("Outbox event published", { eventId: event.id });
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error("Outbox publish loop failed; retrying", {
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

init();
