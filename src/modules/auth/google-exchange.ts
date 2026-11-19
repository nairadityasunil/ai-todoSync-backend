import { randomBytes } from "node:crypto";

import IORedis from "ioredis";

import env from "../../config/env.js";
import logger from "../../lib/logger.js";

import type { AuthResult } from "../../types/auth.js";

/**
 * Google sign-in ends with a redirect from the API to the portal. Cookies set on that redirect belong to the
 * API's own site, so a Partitioned cookie would never be sent when the portal later calls the API. Instead the
 * finished sign-in is parked here under a one-time code; the portal swaps the code for cookies with a normal
 * API call, which sets them in the portal's partition. Codes last 60 seconds and work once.
 */
const TTL_SECONDS = 60;
const PREFIX = "auth:google-exchange:";

const memory = new Map<string, { value: string; expires: number }>();
let redis: InstanceType<typeof IORedis.default> | null = null;

const client = (): InstanceType<typeof IORedis.default> | null => {
  if (redis) return redis;
  try {
    redis = new IORedis.default(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    redis.on("error", () => undefined);
  } catch (error) {
    logger.warn("Google exchange: Redis unavailable, using memory", {
      message: error instanceof Error ? error.message : String(error),
    });
    redis = null;
  }
  return redis;
};

export const storeGoogleSignIn = async (
  result: AuthResult,
): Promise<string> => {
  const code = randomBytes(32).toString("base64url");
  const value = JSON.stringify(result);
  try {
    const r = client();
    if (r) {
      await r.set(PREFIX + code, value, "EX", TTL_SECONDS);
      return code;
    }
  } catch {
    // fall through to memory
  }
  memory.set(code, { value, expires: Date.now() + TTL_SECONDS * 1000 });
  return code;
};

export const takeGoogleSignIn = async (
  code: string,
): Promise<AuthResult | null> => {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return null;
  let raw: string | null = null;
  try {
    const r = client();
    if (r) raw = await r.getdel(PREFIX + code);
  } catch {
    // fall through to memory
  }
  if (!raw) {
    const entry = memory.get(code);
    memory.delete(code);
    if (entry && entry.expires > Date.now()) raw = entry.value;
  }
  for (const [k, v] of memory) if (v.expires <= Date.now()) memory.delete(k);
  return raw ? (JSON.parse(raw) as AuthResult) : null;
};
