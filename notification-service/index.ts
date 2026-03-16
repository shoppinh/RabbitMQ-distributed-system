// notification-service/index.ts
import "../shared/telemetry";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

import { createLogger } from "../shared/utils/logger";
import { startWorker } from "./src/worker";
import { closeConnection } from "../shared/rabbitmq/connection";

const serviceName = "notification-service";
const logger = createLogger(serviceName);

void (async () => {
  try {
    await startWorker(logger);
  } catch (error: unknown) {
    const err = error as Error;
    logger.error("Failed to start notification worker", {
      error: err.message,
    });
    process.exit(1);
  }
})();

const shutdown = async () => {
  logger.warn("Notification service shutdown requested");
  await closeConnection(logger, serviceName);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
