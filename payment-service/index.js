const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { startWorker } = require("./src/worker");
const { closeConnection } = require("../shared/rabbitmq/connection");

const serviceName = "payment-service";
const logger = createLogger(serviceName);

let runtime;

startWorker(logger)
  .then((startedRuntime) => {
    runtime = startedRuntime;
  })
  .catch((error) => {
    logger.error("Failed to start payment worker", { error: error.message });
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
