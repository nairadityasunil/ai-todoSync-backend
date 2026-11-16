import { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import AnalyticsUserModel from "../analytics/models/analytics-user.model.js";
import { maskText, redact } from "../agents/redaction.js";
import { ownIntegration } from "../insights/service.js";
import { LOG_LEVELS, LogEntryModel, type LogLevel } from "./model.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const bad = (m: string) => new AppError(400, m, "BAD_REQUEST");
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Logs: ingest
// ---------------------------------------------------------------------------

export const MAX_LOGS_PER_CALL = 500;
const MAX_ATTRIBUTES = 30;

const LEVEL_ALIASES: Record<string, LogLevel> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  information: "info",
  log: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  critical: "fatal",
  fatal: "fatal",
  panic: "fatal",
};

/** Flattens attributes to a single level of text, numbers and booleans, with secrets and personal data masked. */
export function sanitizeAttributes(
  raw: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const walk = (prefix: string, value: unknown, depth: number) => {
    if (Object.keys(out).length >= MAX_ATTRIBUTES) return;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      depth < 2
    ) {
      for (const [k, v] of Object.entries(value))
        walk(prefix ? `${prefix}_${k}` : k, v, depth + 1);
      return;
    }
    // Names are plain words: a dot in a name would read as a path in the database, so nested names join with an underscore.
    const key = prefix.replace(/[^\w-]/g, "_").slice(0, 60);
    if (!key || /^_+$/.test(key) || prefix.startsWith("$")) return;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string")
      out[key] = maskText(value.slice(0, 500));
    else if (value !== null && value !== undefined)
      out[key] = maskText(JSON.stringify(value).slice(0, 500));
  };
  for (const [k, v] of Object.entries(raw)) walk(k, v, 0);
  return out;
}

export interface LogInput {
  logId?: unknown;
  level?: unknown;
  message?: unknown;
  service?: unknown;
  timestamp?: unknown;
  attributes?: unknown;
  traceId?: unknown;
  userIdentifier?: unknown;
}

export function normalizeLog(
  integrationId: string,
  raw: LogInput,
  index: number,
  now = Date.now(),
) {
  const message = typeof raw.message === "string" ? raw.message : "";
  if (!message.trim()) throw bad(`Log ${index + 1}: message is required`);
  const level = LEVEL_ALIASES[String(raw.level ?? "info").toLowerCase()];
  if (!level)
    throw bad(
      `Log ${index + 1}: level must be one of ${LOG_LEVELS.join(", ")}`,
    );
  let ts = now;
  if (raw.timestamp !== undefined && raw.timestamp !== null) {
    const t =
      typeof raw.timestamp === "number"
        ? raw.timestamp
        : new Date(String(raw.timestamp)).getTime();
    if (!Number.isFinite(t) || t > now + 5 * MIN || t < now - 30 * DAY)
      throw bad(`Log ${index + 1}: timestamp must be within the last 30 days`);
    ts = t;
  }
  return {
    integrationId,
    logId: str(raw.logId, 64) || null,
    ts: new Date(ts),
    level,
    service: str(raw.service, 80) || "app",
    // Secrets and personal data are masked before anything is stored.
    message: maskText(message.slice(0, 8000)),
    attributes: sanitizeAttributes(raw.attributes),
    traceId: str(raw.traceId, 80) || null,
    userIdentifier: str(raw.userIdentifier, 200) || null,
  };
}

export async function ingestLogs(
  integrationId: string,
  body: unknown,
): Promise<{ accepted: number; duplicates: number }> {
  const list = Array.isArray(body)
    ? body
    : body &&
        typeof body === "object" &&
        Array.isArray((body as { logs?: unknown }).logs)
      ? (body as { logs: unknown[] }).logs
      : body && typeof body === "object" && "message" in body
        ? [body]
        : [];
  if (!list.length) throw bad('Send { "logs": [{ "level", "message", ... }] }');
  if (list.length > MAX_LOGS_PER_CALL)
    throw bad(`Send at most ${MAX_LOGS_PER_CALL} logs per call`);
  const docs = list.map((raw, i) =>
    normalizeLog(integrationId, (raw ?? {}) as LogInput, i),
  );
  // A retry of a batch that already arrived must not store its logs again.
  const ids = docs
    .map((d) => d.logId)
    .filter((id): id is string => Boolean(id));
  const seen = ids.length
    ? new Set(
        (
          await LogEntryModel.find({ integrationId, logId: { $in: ids } })
            .select("logId")
            .lean()
        ).map((r) => r.logId),
      )
    : new Set<string | null>();
  const fresh = docs.filter((d) => !d.logId || !seen.has(d.logId));
  // Every entry is checked above before anything is stored; an ordered insert stops at the first database error.
  if (fresh.length) await LogEntryModel.insertMany(fresh, { ordered: true });
  return { accepted: docs.length, duplicates: docs.length - fresh.length };
}

// ---------------------------------------------------------------------------
// Logs: search
// ---------------------------------------------------------------------------

export interface LogQuery {
  userId: string;
  integrationId: unknown;
  from?: unknown;
  to?: unknown;
  range?: unknown;
  levels?: unknown;
  service?: unknown;
  q?: unknown;
  attr?: unknown;
  traceId?: unknown;
  before?: unknown;
  after?: unknown;
  limit?: unknown;
  now?: number;
}

const RANGES: Record<string, number> = {
  "15m": 15 * MIN,
  "1h": HOUR,
  "6h": 6 * HOUR,
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

function logFilter(q: LogQuery, integrationId: string) {
  const now = q.now ?? Date.now();
  const custom = Boolean(q.from && q.to);
  const span = custom ? 0 : RANGES[String(q.range ?? "1h")];
  if (!span && !custom) throw bad("Range must be 15m, 1h, 6h, 24h, 7d or 30d");
  let from = span ? now - span : new Date(String(q.from)).getTime();
  let to = span ? now : new Date(String(q.to)).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw bad("Choose a time range that starts before it ends");
  from = Math.max(from, now - 30 * DAY);
  const filter: Record<string, unknown> = {
    integrationId,
    ts: { $gte: new Date(from), $lte: new Date(to) },
  };
  const levels = (
    Array.isArray(q.levels)
      ? q.levels
      : typeof q.levels === "string"
        ? q.levels.split(",")
        : []
  ).filter((l): l is LogLevel =>
    (LOG_LEVELS as readonly string[]).includes(String(l)),
  );
  if (levels.length && levels.length < LOG_LEVELS.length)
    filter.level = { $in: levels };
  const service = str(q.service, 80);
  if (service) filter.service = service;
  const text = str(q.q, 200);
  if (text) filter.message = { $regex: escapeRegex(text), $options: "i" };
  const traceId = str(q.traceId, 80);
  if (traceId) filter.traceId = traceId;
  // key:value on an attribute, exact match. Keys with dots are plain keys, so the key is checked first.
  const attr = str(q.attr, 200);
  if (attr) {
    const at = attr.indexOf(":");
    if (at < 1)
      throw bad("Filter attributes as key:value, for example status:500");
    const key = attr.slice(0, at).trim();
    if (!/^[\w-]{1,60}$/.test(key))
      throw bad("That attribute name is not valid");
    const raw = attr.slice(at + 1).trim();
    const value: string | number | boolean =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : raw !== "" && !Number.isNaN(Number(raw))
            ? Number(raw)
            : raw;
    filter[`attributes.${key}`] = value;
  }
  return { filter, from, to, now };
}

const view = (r: {
  _id: unknown;
  ts: Date;
  level: string;
  service: string;
  message: string;
  attributes: unknown;
  traceId: string | null;
  userIdentifier: string | null;
}) => ({
  id: String(r._id),
  ts: r.ts,
  level: r.level,
  service: r.service,
  message: r.message,
  attributes: r.attributes ?? {},
  traceId: r.traceId,
  userIdentifier: r.userIdentifier,
});

export async function searchLogs(q: LogQuery) {
  const integration = await ownIntegration(q.userId, q.integrationId);
  const { filter, from, to } = logFilter(q, integration.id);
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const ts = filter.ts as Record<string, Date>;
  // Paging back in time (before) and following live (after) both use the entry time as the cursor.
  if (q.before) {
    const t = new Date(String(q.before));
    if (Number.isNaN(t.getTime())) throw bad("before must be a time");
    ts.$lt = t;
  }
  if (q.after) {
    const t = new Date(String(q.after));
    if (Number.isNaN(t.getTime())) throw bad("after must be a time");
    ts.$gt = t;
    delete (filter.ts as Record<string, unknown>).$gte;
  }
  const rows = await LogEntryModel.find(filter)
    .sort({ ts: -1 })
    .limit(limit + 1)
    .lean();
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    from,
    to,
    logs: page.map(view),
    hasMore: more,
    nextBefore: more ? page[page.length - 1].ts : null,
    newest: page[0]?.ts ?? null,
  };
}

/** Counts per level over time, for the volume chart, plus totals per level and service. */
export async function logStats(q: LogQuery) {
  const integration = await ownIntegration(q.userId, q.integrationId);
  const { filter, from, to } = logFilter(q, integration.id);
  const CAP = 50_000;
  const rows = await LogEntryModel.find(filter)
    .select("ts level service")
    .sort({ ts: -1 })
    .limit(CAP + 1)
    .lean();
  const truncated = rows.length > CAP;
  const used = truncated ? rows.slice(0, CAP) : rows;
  const span = to - from;
  const step =
    span <= 30 * MIN
      ? MIN
      : span <= 3 * HOUR
        ? 5 * MIN
        : span <= 12 * HOUR
          ? 15 * MIN
          : span <= DAY
            ? HOUR / 2
            : span <= 3 * DAY
              ? HOUR
              : 6 * HOUR;
  const start = Math.floor(from / step) * step;
  const count = Math.max(1, Math.ceil((to - start) / step));
  const buckets = Array.from({ length: count }, (_, i) => ({
    t: start + i * step,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  }));
  const byLevel: Record<string, number> = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  };
  const byService: Record<string, number> = {};
  for (const r of used) {
    const i = Math.min(
      count - 1,
      Math.max(0, Math.floor((r.ts.getTime() - start) / step)),
    );
    buckets[i][r.level as LogLevel]++;
    byLevel[r.level]++;
    byService[r.service] = (byService[r.service] ?? 0) + 1;
  }
  return {
    from,
    to,
    step,
    truncated,
    total: used.length,
    buckets,
    byLevel,
    services: Object.entries(byService)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([name, count]) => ({ name, count })),
  };
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

export async function liveEvents(input: {
  userId: string;
  integrationId: unknown;
  after?: unknown;
  event?: unknown;
  user?: unknown;
  limit?: unknown;
}) {
  const integration = await ownIntegration(input.userId, input.integrationId);
  const filter: Record<string, unknown> = { sdkIntegrationId: integration.id };
  const createdAt: Record<string, Date> = {};
  if (input.after) {
    const t = new Date(String(input.after));
    if (Number.isNaN(t.getTime())) throw bad("after must be a time");
    createdAt.$gt = t;
  } else createdAt.$gte = new Date(Date.now() - DAY);
  filter.createdAt = createdAt;
  const event = str(input.event, 200);
  if (event) filter.eventName = event;
  const user = str(input.user, 200);
  if (user) filter.userIdentifier = user;
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
  const rows = await AnalyticsLogModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return {
    events: rows.map((r) => ({
      id: String(r._id),
      at: r.createdAt,
      event: r.eventName ?? r.eventRef ?? "unknown",
      user: r.userIdentifier ?? null,
      session: r.sessionId ?? null,
      properties: redact(r.payload ?? {}),
    })),
    newest: rows[0]?.createdAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------

const PERSON_SCAN_CAP = 100_000;

export async function listPersons(input: {
  userId: string;
  integrationId: unknown;
  q?: unknown;
  limit?: unknown;
}) {
  const integration = await ownIntegration(input.userId, input.integrationId);
  const since = new Date(Date.now() - 90 * DAY);
  const rows = await AnalyticsLogModel.find({
    sdkIntegrationId: integration.id,
    createdAt: { $gte: since },
    userIdentifier: { $exists: true, $ne: null },
  })
    .select("userIdentifier createdAt sessionId")
    .sort({ createdAt: -1 })
    .limit(PERSON_SCAN_CAP + 1)
    .lean();
  const truncated = rows.length > PERSON_SCAN_CAP;
  const people = new Map<
    string,
    {
      id: string;
      events: number;
      first: Date;
      last: Date;
      sessions: Set<string>;
    }
  >();
  for (const r of truncated ? rows.slice(0, PERSON_SCAN_CAP) : rows) {
    const id = String(r.userIdentifier);
    const p = people.get(id) ?? {
      id,
      events: 0,
      first: r.createdAt,
      last: r.createdAt,
      sessions: new Set<string>(),
    };
    p.events++;
    if (r.createdAt < p.first) p.first = r.createdAt;
    if (r.createdAt > p.last) p.last = r.createdAt;
    if (r.sessionId) p.sessions.add(r.sessionId);
    people.set(id, p);
  }
  const text = str(input.q, 100).toLowerCase();
  let list = [...people.values()];
  if (text) list = list.filter((p) => p.id.toLowerCase().includes(text));
  list.sort((a, b) => b.last.getTime() - a.last.getTime());
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
  const page = list.slice(0, limit);
  const props = await AnalyticsUserModel.find({
    apiKeyId: integration.id,
    userIdentifier: { $in: page.map((p) => p.id) },
  })
    .select("userIdentifier metadata")
    .lean();
  const meta = new Map(props.map((u) => [u.userIdentifier, u.metadata ?? {}]));
  return {
    total: list.length,
    truncated,
    persons: page.map((p) => ({
      id: p.id,
      events: p.events,
      sessions: p.sessions.size,
      firstSeen: p.first,
      lastSeen: p.last,
      properties: pickProps(meta.get(p.id)),
    })),
  };
}

/** A few properties for a list row: text and numbers only, never nested data. */
function pickProps(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 5) break;
    if (typeof v === "string") out[k] = maskText(v.slice(0, 120));
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

export async function personProfile(input: {
  userId: string;
  integrationId: unknown;
  identifier: string;
  limit?: unknown;
}) {
  const integration = await ownIntegration(input.userId, input.integrationId);
  const id = str(input.identifier, 200);
  if (!id) throw bad("Choose a person");
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 100));
  const [stored, recent, counts] = await Promise.all([
    AnalyticsUserModel.findOne({
      apiKeyId: integration.id,
      userIdentifier: id,
    }).lean(),
    AnalyticsLogModel.find({
      sdkIntegrationId: integration.id,
      userIdentifier: id,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
    AnalyticsLogModel.find({
      sdkIntegrationId: integration.id,
      userIdentifier: id,
    })
      .select("eventName eventRef sessionId createdAt")
      .sort({ createdAt: -1 })
      .limit(20_000)
      .lean(),
  ]);
  if (!stored && !counts.length)
    throw new AppError(404, "Person not found", "NOT_FOUND");
  const byEvent = new Map<string, number>();
  const sessions = new Set<string>();
  for (const r of counts) {
    const name = r.eventName ?? r.eventRef ?? "unknown";
    byEvent.set(name, (byEvent.get(name) ?? 0) + 1);
    if (r.sessionId) sessions.add(r.sessionId);
  }
  const props: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(stored?.metadata ?? {})) {
    if (typeof v === "string") props[k] = maskText(v.slice(0, 300));
    else if (typeof v === "number" || typeof v === "boolean") props[k] = v;
  }
  return {
    id,
    properties: props,
    firstSeen: counts.length
      ? counts[counts.length - 1].createdAt
      : (stored?.createdAt ?? null),
    lastSeen: counts[0]?.createdAt ?? null,
    events: counts.length,
    sessions: sessions.size,
    topEvents: [...byEvent.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    timeline: recent.map((r) => ({
      id: String(r._id),
      at: r.createdAt,
      event: r.eventName ?? r.eventRef ?? "unknown",
      session: r.sessionId ?? null,
      properties: redact(r.payload ?? {}),
    })),
  };
}

export const isId = (v: unknown): v is string =>
  typeof v === "string" && Types.ObjectId.isValid(v);
