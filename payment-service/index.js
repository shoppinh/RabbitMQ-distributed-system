require("../shared/telemetry");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { startWorker } = require("./src/worker");
const { startOutboxWorker } = require("./src/outboxWorker");
const { closeConnection } = require("../shared/rabbitmq/connection");

const serviceName = "payment-service";
const logger = createLogger(serviceName);

let runtime;

async function main() {
  logger.info("Starting Payment Service", {
    components: ["worker", "outbox-worker"],
  });

  // Start worker first
  runtime = await startWorker(logger);

  // Start outbox worker in parallel
  startOutboxWorker(logger).catch((err) => {
    logger.error("Outbox worker failed", { error: err.message });
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error("Failed to start payment service", { error: error.message });
  process.exit(1);
});

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
