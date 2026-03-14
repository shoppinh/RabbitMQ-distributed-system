require("../shared/telemetry");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { startServer } = require("./src/server");
const { startOutboxWorker } = require("./src/outboxWorker");
const { startTimeoutChecker } = require("./src/timeoutChecker");
const { startWorker } = require("./src/worker");

const serviceName = "order-service";
const logger = createLogger(serviceName);

async function main() {
  logger.info("Starting Order Service", {
    components: ["http-server", "worker", "outbox-worker", "timeout-checker"],
  });

  // Start HTTP and other components in parallel
  await Promise.all([
    startServer(logger).catch((err) => {
      logger.error("HTTP server failed", { error: err.message });
      process.exit(1);
    }),
    startWorker(logger).catch((err) => {
      logger.error("Worker failed", { error: err.message });
      process.exit(1);
    }),
    startOutboxWorker(logger).catch((err) => {
      logger.error("Outbox worker failed", { error: err.message });
      process.exit(1);
    }),
    startTimeoutChecker(logger).catch((err) => {
      logger.error("Timeout checker failed", { error: err.message });
      process.exit(1);
    }),
  ]);
}

main();
