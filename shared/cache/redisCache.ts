// shared/cache/redisCache.ts
import Redis from "ioredis";
import { getRedisConfig } from "../config/env";
import type { Logger } from "../utils/logger";

let redisClient: Redis | null = null;

export function getRedisClient(logger?: Logger): Redis {
  if (redisClient) {
    return redisClient;
  }

  const config = getRedisConfig();

  redisClient = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    lazyConnect: true,
    enableOfflineQueue: false, // Don't queue commands when disconnected
    maxRetriesPerRequest: 2,
  });

  redisClient.on("connect", () => {
    logger?.info("Redis connected");
  });

  redisClient.on("error", (err: Error) => {
    logger?.error("Redis error", { error: err.message });
  });

  redisClient.on("close", () => {
    logger?.warn("Redis connection closed");
  });

  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// -----------------------------------------------------------------------
// Generic safe cache helpers — if Redis is unavailable, fall through to DB
// -----------------------------------------------------------------------

/**
 * Attempt to get a cached value. Returns null on cache miss or Redis error.
 */
export async function cacheGet<T>(
  key: string,
  logger?: Logger
): Promise<T | null> {
  try {
    const client = getRedisClient(logger);
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger?.warn("Cache GET failed (falling through to DB)", {
      key,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Attempt to cache a value with TTL. Silently fails if Redis is unavailable.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
  logger?: Logger
): Promise<void> {
  try {
    const client = getRedisClient(logger);
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    logger?.warn("Cache SET failed (non-fatal)", {
      key,
      error: (err as Error).message,
    });
  }
}

/**
 * Invalidate a cache key. Silently fails if Redis is unavailable.
 */
export async function cacheDelete(key: string, logger?: Logger): Promise<void> {
  try {
    const client = getRedisClient(logger);
    await client.del(key);
  } catch (err) {
    logger?.warn("Cache DELETE failed (non-fatal)", {
      key,
      error: (err as Error).message,
    });
  }
}

// -----------------------------------------------------------------------
// Key-builders for consistent cache key naming
// -----------------------------------------------------------------------

export const CacheKeys = {
  customerOrders: (customerId: string) =>
    `orders:customer:${customerId}`,
  sagaStatus: (sagaId: string) =>
    `saga:${sagaId}`,
} as const;

// -----------------------------------------------------------------------
// TTL constants (in seconds)
// -----------------------------------------------------------------------

export const CacheTTL = {
  CUSTOMER_ORDERS: 30,  // short TTL since orders change frequently
  SAGA_STATUS: 10,
} as const;
