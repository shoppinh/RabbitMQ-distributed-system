function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getCommonConfig(serviceName) {
  return {
    serviceName,
    rabbitmqUrl:
      process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672",
    orderExchange: process.env.ORDER_EXCHANGE || "order_exchange",
    retryDelayMs: parseNumber(process.env.RETRY_DELAY_MS, 5000),
    maxRetries: parseNumber(process.env.MAX_RETRIES, 3),
    prefetchCount: parseNumber(process.env.PREFETCH_COUNT, 1),
  };
}

function getDatabaseConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseNumber(process.env.DB_PORT, 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "orders_db",
    max: parseNumber(process.env.DB_MAX_POOL_SIZE, 10),
  };
}

module.exports = {
  getCommonConfig,
  getDatabaseConfig,
};
