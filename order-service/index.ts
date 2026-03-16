// order-service/index.ts
import "../shared/telemetry";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

import { createLogger } from "../shared/utils/logger";
import { startServer } from "./src/server";
import { startOutboxWorker } from "./src/outboxWorker";
import { startTimeoutChecker } from "./src/timeoutChecker";
import { startWorker } from "./src/worker";

const serviceName = "order-service";
const logger = createLogger(serviceName);

async function main(): Promise<void> {
  logger.info("Starting Order Service", {
    components: ["http-server", "worker", "outbox-worker", "timeout-checker"],
  });

  await Promise.all([
    startServer(logger).catch((err: Error) => {
      logger.error("HTTP server failed", { error: err.message });
      process.exit(1);
    }),
    startWorker(logger).catch((err: Error) => {
      logger.error("Worker failed", { error: err.message });
      process.exit(1);
    }),
    startOutboxWorker(logger).catch((err: Error) => {
      logger.error("Outbox worker failed", { error: err.message });
      process.exit(1);
    }),
    startTimeoutChecker(logger).catch((err: Error) => {
      logger.error("Timeout checker failed", { error: err.message });
      process.exit(1);
    }),
  ]);
}

main();
