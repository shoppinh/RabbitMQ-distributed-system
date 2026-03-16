// inventory-service/index.ts
import "../shared/telemetry";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

import { createLogger } from "../shared/utils/logger";
import { startWorker } from "./src/worker";
import { startOutboxWorker } from "./src/outboxWorker";
import { closeConnection } from "../shared/rabbitmq/connection";

const serviceName = "inventory-service";
const logger = createLogger(serviceName);

async function main(): Promise<void> {
  logger.info("Starting Inventory Service", {
    components: ["worker", "outbox-worker"],
  });

  await startWorker(logger);

  startOutboxWorker(logger).catch((err: Error) => {
    logger.error("Outbox worker failed", { error: err.message });
    process.exit(1);
  });
}

void (async () => {
  try {
    await main();
  } catch (error: unknown) {
    const err = error as Error;
    logger.error("Failed to start inventory service", { error: err.message });
    process.exit(1);
  }
})();

const shutdown = async () => {
  logger.warn("Inventory service shutdown requested");
  await closeConnection(logger, serviceName);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
