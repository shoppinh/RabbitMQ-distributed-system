const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { startWorker } = require("./src/worker");
const { closeConnection } = require("../shared/rabbitmq/connection");

const serviceName = "inventory-service";
const logger = createLogger(serviceName);

let runtime;

(async () => {
  try {
    runtime = await startWorker(logger);
  } catch (error) {
    logger.error("Failed to start inventory worker", {
      error: error.message,
    });
    process.exit(1);
  }
})();

const shutdown = async () => {
  logger.warn("Inventory service shutdown requested");
  if (runtime) {
    await runtime.stop();
  }
  await closeConnection(logger, serviceName);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
