require("../shared/telemetry");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { startServer } = require("./src/server");
const { startOutboxWorker } = require("./src/outboxWorker");
const { startTimeoutChecker } = require("./src/timeoutChecker");

const serviceName = "order-service";
const logger = createLogger(serviceName);

async function main() {
  logger.info("Starting Order Service", {
    components: ["http-server", "outbox-worker", "timeout-checker"],
  });

  // Start all three components in parallel
  // They share the same process but are independent
  await Promise.all([
    startServer(logger).catch((err) => {
      logger.error("HTTP server failed", { error: err.message });
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
