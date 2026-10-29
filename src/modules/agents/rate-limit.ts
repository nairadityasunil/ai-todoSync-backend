import IORedis from "ioredis";

import env from "../../config/env.js";
import logger from "../../lib/logger.js";

/**
 * Per-agent call limits, in fixed one-minute windows. Counts live in Redis
 * when it is reachable, so every instance shares them; otherwise each
 * process counts on its own (the limit then applies per instance).
 */

export const MAX_RATE_LIMIT_PER_MINUTE = 10_000;
const WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  /** Calls made in this window, including this one. */
  count: number;
  /** Seconds until the window resets. */
  retryAfterSec: number;
}

/** Pure counting rule, shared by both stores. */
export function decide(
  count: number,
  limit: number,
  now: number,
): RateDecision {
  const windowEnd = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;
  return {
    allowed: count <= limit,
    count,
    retryAfterSec: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}

/** A limit from user input: a whole number from 1 to the maximum, or null for none. */
export function normalizeRateLimit(value: unknown): number | null | undefined {
  if (value === null || value === "" || value === 0) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RATE_LIMIT_PER_MINUTE)
    return undefined;
  return n;
}

let redis: InstanceType<typeof IORedis.default> | null = null;
let redisWarned = false;

const client = () => {
  if (!redis) {
    redis = new IORedis.default(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 2000, 30_000),
    });
    redis.on("error", (error) => {
      if (redisWarned) return;
      redisWarned = true;
      logger.warn(
        "Agent rate limits are counted per instance: Redis unavailable",
        {
          message: error.message,
        },
      );
    });
    redis.on("ready", () => {
      redisWarned = false;
    });
    redis.connect().catch(() => undefined);
  }
  return redis;
};

const memory = new Map<string, { window: number; count: number }>();

const countInMemory = (agentId: string, window: number): number => {
  const entry = memory.get(agentId);
  if (entry && entry.window === window) {
    entry.count += 1;
    return entry.count;
  }
  if (memory.size > 50_000) memory.clear();
  memory.set(agentId, { window, count: 1 });
  return 1;
};

/** Counts one call for the agent and says whether it is within its limit. */
export async function consume(
  agentId: string,
  limitPerMinute: number,
  now = Date.now(),
): Promise<RateDecision> {
  const window = Math.floor(now / WINDOW_MS);
  const redisClient = client();
  if (redisClient.status === "ready") {
    try {
      const key = `agent-rate:${agentId}:${window}`;
      const [[, count]] = (await redisClient
        .multi()
        .incr(key)
        .pexpire(key, WINDOW_MS * 2)
        .exec()) as [[Error | null, number]];
      return decide(Number(count), limitPerMinute, now);
    } catch {
      // Fall through to the local count.
    }
  }
  return decide(countInMemory(agentId, window), limitPerMinute, now);
}
