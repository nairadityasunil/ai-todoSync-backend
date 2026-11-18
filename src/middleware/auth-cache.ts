/**
 * A short memory of who a signed-in request belongs to.
 *
 * Every request used to read the person and their device session from the database before doing anything,
 * two queries on each of dozens of calls per page. This keeps the raw documents for a few seconds and builds
 * fresh document objects from them, so each request still gets its own copy to work with.
 *
 * It is cleared whenever a user or a device session changes through the app (sign out, suspend, password
 * reset, role change, refresh), so revoking access works at once on this server; other servers see it within
 * the time to live. Set AUTH_CACHE_TTL_MS=0 to turn it off.
 */
const ttl = (): number => {
  const raw = process.env.AUTH_CACHE_TTL_MS;
  const n = raw === undefined ? 10_000 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
};

interface Entry {
  at: number;
  user: Record<string, unknown>;
  session: Record<string, unknown> & {
    expiresAt?: Date | string;
    revokedAt?: Date | null;
  };
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 5000;

export const authCacheEnabled = (): boolean => ttl() > 0;

export const getCachedAuth = (key: string): Entry | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= ttl()) {
    cache.delete(key);
    return undefined;
  }
  // A session that has run out of time is never served from memory.
  if (
    hit.session.revokedAt ||
    (hit.session.expiresAt &&
      new Date(hit.session.expiresAt).getTime() <= Date.now())
  ) {
    cache.delete(key);
    return undefined;
  }
  return hit;
};

export const setCachedAuth = (
  key: string,
  user: Entry["user"],
  session: Entry["session"],
): void => {
  if (!authCacheEnabled()) return;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), user, session });
};

/** Forget everything: called when any user or device session changes. */
export const clearAuthCache = (): void => {
  cache.clear();
};
