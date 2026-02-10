const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const { createLogger } = require("../shared/utils/logger");
const { startServer } = require("./src/server");

const serviceName = "order-service";
const logger = createLogger(serviceName);

startServer(logger).catch((error) => {
  logger.error("Failed to start order service", { error: error.message });
  process.exit(1);
});
