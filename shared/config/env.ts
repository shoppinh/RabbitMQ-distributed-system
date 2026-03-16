// shared/config/env.ts
import { parseNumber } from "../utils/parseNumber";

export interface CommonConfig {
  serviceName: string;
  rabbitmqUrl: string;
  orderExchange: string;
  retryDelayMs: number;
  maxRetries: number;
  prefetchCount: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export function getCommonConfig(serviceName: string): CommonConfig {
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

export function getDatabaseConfig(): DatabaseConfig {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseNumber(process.env.DB_PORT, 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "orders_db",
    max: parseNumber(process.env.DB_MAX_POOL_SIZE, 10),
  };
}

export function getRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || "localhost",
    port: parseNumber(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}
