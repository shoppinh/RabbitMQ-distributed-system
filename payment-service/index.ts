// payment-service/index.ts
import "../shared/telemetry";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

import { createLogger } from "../shared/utils/logger";
import { startWorker } from "./src/worker";
import { startOutboxWorker } from "./src/outboxWorker";
import { closeConnection } from "../shared/rabbitmq/connection";
import type { ConsumerService } from "../shared/rabbitmq/consumerService";

const serviceName = "payment-service";
const logger = createLogger(serviceName);

let runtime: ConsumerService | undefined;

async function main(): Promise<void> {
  logger.info("Starting Payment Service", {
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
    logger.error("Failed to start payment service", { error: err.message });
    process.exit(1);
  }
})();

const shutdown = async () => {
  logger.warn("Payment service shutdown requested");
  if (runtime) {
    await runtime.stop();
  }
  await closeConnection(logger, serviceName);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
