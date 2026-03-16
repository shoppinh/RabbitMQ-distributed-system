// order-service/src/outboxWorker.ts
import { createConfirmChannel, closeConnection } from "../../shared/rabbitmq/connection";
import { publishOutboxEventConfirmed, OutboxEventRow } from "../../shared/rabbitmq/message";
import { getCommonConfig } from "../../shared/config/env";
import { pool } from "../config/db";
import { parseNumber } from "../../shared/utils/parseNumber";
import type { Logger } from "../../shared/utils/logger";

const POLL_INTERVAL_MS = parseNumber(process.env.OUTBOX_POLL_INTERVAL_MS, 1000);
const BATCH_SIZE = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startOutboxWorker(logger: Logger): Promise<void> {
  const config = getCommonConfig("order-service-outbox");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  logger.info("Starting Order Service outbox worker", {
    exchange: exchangeName,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  const channel = await createConfirmChannel({
    rabbitmqUrl: config.rabbitmqUrl,
    logger,
    serviceName: config.serviceName,
  });

  const shutdown = async () => {
    logger.warn("Order service outbox worker shutdown requested");
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

      const result = await client.query<OutboxEventRow>(
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

          logger.info("Order outbox event published", {
            eventId: event.id,
            type: event.type,
            routingKey: event.routing_key,
          });
        } catch (publishError) {
          const err = publishError as Error;
          logger.error("Failed to publish outbox event", {
            eventId: event.id,
            error: err.message,
          });
          throw publishError;
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      const err = error as Error;
      logger.error("Order outbox publish loop failed; retrying", {
        error: err.message,
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
