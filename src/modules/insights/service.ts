import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import { AppError } from "../../utils/app-error.js";
import agentService from "../agents/agent.service.js";
import { adminWorkspaces } from "../agents/http.js";
import { AgentActivityModel } from "../agents/model.js";
import AnalyticsEventRegistryModel from "../analytics/models/analytics-event-registry.model.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import projectService from "../project/services/project.service.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";
import TaskModel from "../task/models/task.model.js";
import { closeTask, openTask } from "../telemetry/automation.service.js";
import { AutomationLinkModel } from "../telemetry/model.js";
import {
  bucketStart,
  cohortMembers,
  defaultInterval,
  evaluateAlert,
  funnel,
  MATH_OPS,
  paths,
  retention,
  sanitizeFilters,
  trends,
  type CohortDefinition,
  type EventRow,
  type Interval,
  type MathOp,
  type PropertyFilter,
  type TrendSeriesSpec,
} from "./engine.js";
import { CohortModel, MetricAlertModel, type InsightKind } from "./model.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Most rows one query reads. Beyond this the answer is marked as partial rather than slowing everyone down. */
export const MAX_ROWS = 200_000;

/* ------------------------------------------------------------------ */
/* Access                                                               */
/* ------------------------------------------------------------------ */

/** The SDK integration, if this person owns it. Integrations belong to the person who created them. */
export async function ownIntegration(userId: string, integrationId: unknown) {
  if (
    typeof integrationId !== "string" ||
    !Types.ObjectId.isValid(integrationId)
  )
    throw new AppError(400, "Choose an SDK integration", "BAD_REQUEST");
  const integration = await SdkIntegrationModel.findOne({
    _id: integrationId,
    tenantId: userId,
  })
    .select("_id name")
    .lean();
  if (!integration)
    throw new AppError(404, "SDK integration not found", "NOT_FOUND");
  return { id: String(integration._id), name: String(integration.name) };
}

export async function listIntegrations(userId: string) {
  const rows = await SdkIntegrationModel.find({
    tenantId: userId,
    status: { $ne: "revoked" },
  })
    .select("_id name status")
    .sort({ createdAt: 1 })
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    name: String(r.name),
    status: String(r.status),
  }));
}

/* ------------------------------------------------------------------ */
/* Loading events                                                       */
/* ------------------------------------------------------------------ */

async function eventNames(
  integrationId: string,
  logs: Array<{ eventName?: string | null; eventRef?: string | null }>,
) {
  const refs = [
    ...new Set(
      logs
        .filter((l) => !l.eventName && l.eventRef)
        .map((l) => String(l.eventRef)),
    ),
  ];
  if (!refs.length) return new Map<string, string>();
  const rows = await AnalyticsEventRegistryModel.find({
    _id: { $in: refs.filter((r) => Types.ObjectId.isValid(r)) },
  })
    .select("_id eventName")
    .lean();
  return new Map(rows.map((r) => [String(r._id), String(r.eventName)]));
}

/** SDK events of one integration in a time range, as engine rows. */
export async function loadEvents(
  integrationId: string,
  from: number,
  to: number,
): Promise<{ rows: EventRow[]; truncated: boolean }> {
  const logs = await AnalyticsLogModel.find({
    sdkIntegrationId: integrationId,
    createdAt: { $gte: new Date(from), $lte: new Date(to) },
  })
    .select("eventName eventRef userIdentifier sessionId payload createdAt")
    .sort({ createdAt: -1 })
    .limit(MAX_ROWS + 1)
    .lean();
  const truncated = logs.length > MAX_ROWS;
  const kept = truncated ? logs.slice(0, MAX_ROWS) : logs;
  const names = await eventNames(integrationId, kept);
  return {
    truncated,
    rows: kept.map((l) => ({
      e: l.eventName ?? names.get(String(l.eventRef)) ?? "event",
      u: l.userIdentifier || null,
      s: l.sessionId || null,
      t: new Date(l.createdAt).getTime(),
      p: (l.payload ?? {}) as Record<string, unknown>,
    })),
  };
}

/** Pristine's own metrics as rows (one row per occurrence, with a value where it has one). */
export const PRISTINE_METRICS = [
  { id: "tasks_created", label: "Tasks created", unit: "count" },
  { id: "tasks_completed", label: "Tasks completed", unit: "count" },
  {
    id: "sla_breaches",
    label: "Tasks that missed their deadline",
    unit: "count",
  },
  { id: "agent_actions", label: "Agent actions", unit: "count" },
  { id: "agent_blocked", label: "Agent actions blocked", unit: "count" },
  { id: "agent_held", label: "Agent actions held for approval", unit: "count" },
  { id: "ai_calls", label: "AI calls", unit: "count" },
  { id: "ai_cost", label: "AI cost (USD)", unit: "usd" },
  { id: "ai_tokens", label: "AI tokens", unit: "count" },
] as const;
export type PristineMetric = (typeof PRISTINE_METRICS)[number]["id"];
const PRISTINE_IDS = PRISTINE_METRICS.map((m) => m.id) as string[];

export async function loadPristine(
  userId: string,
  metrics: string[],
  from: number,
  to: number,
): Promise<{ rows: EventRow[]; truncated: boolean }> {
  const range = { $gte: new Date(from), $lte: new Date(to) };
  const wanted = new Set(metrics.filter((m) => PRISTINE_IDS.includes(m)));
  const rows: EventRow[] = [];
  let truncated = false;
  const cap = <T>(list: T[]) => {
    if (list.length > MAX_ROWS) truncated = true;
    return list.slice(0, MAX_ROWS);
  };

  if (
    wanted.has("tasks_created") ||
    wanted.has("tasks_completed") ||
    wanted.has("sla_breaches")
  ) {
    const projectIds = (await projectService.fetchProjects(userId)).map(
      (p) => new Types.ObjectId(p.id),
    );
    const scope = {
      $or: [
        { projectId: { $in: projectIds } },
        { projectId: null, userId: new Types.ObjectId(userId) },
      ],
    };
    if (wanted.has("tasks_created")) {
      for (const t of cap(
        await TaskModel.find({ ...scope, createdAt: range })
          .select("createdAt assignedTo projectId priority")
          .limit(MAX_ROWS + 1)
          .lean(),
      ))
        rows.push({
          e: "tasks_created",
          u: t.assignedTo ? String(t.assignedTo) : null,
          s: null,
          t: new Date(t.createdAt as Date).getTime(),
          p: {
            project: t.projectId ? String(t.projectId) : null,
            priority: t.priority,
          },
        });
    }
    if (wanted.has("tasks_completed")) {
      for (const t of cap(
        await TaskModel.find({ ...scope, completedAt: range })
          .select("completedAt assignedTo projectId priority")
          .limit(MAX_ROWS + 1)
          .lean(),
      ))
        rows.push({
          e: "tasks_completed",
          u: t.assignedTo ? String(t.assignedTo) : null,
          s: null,
          t: new Date(t.completedAt as Date).getTime(),
          p: {
            project: t.projectId ? String(t.projectId) : null,
            priority: t.priority,
          },
        });
    }
    if (wanted.has("sla_breaches")) {
      for (const t of cap(
        await TaskModel.find({
          ...scope,
          resolutionBreached: true,
          slaResolutionDueAt: range,
        })
          .select("slaResolutionDueAt assignedTo projectId priority")
          .limit(MAX_ROWS + 1)
          .lean(),
      ))
        rows.push({
          e: "sla_breaches",
          u: t.assignedTo ? String(t.assignedTo) : null,
          s: null,
          t: new Date(t.slaResolutionDueAt as Date).getTime(),
          p: {
            project: t.projectId ? String(t.projectId) : null,
            priority: t.priority,
          },
        });
    }
  }

  const agentMetrics = ["agent_actions", "agent_blocked", "agent_held"].filter(
    (m) => wanted.has(m),
  );
  if (agentMetrics.length) {
    // Admins see their workspaces' agents; others their own agents.
    const admin = await adminWorkspaces(userId);
    const filter = admin.length
      ? { workspaceId: { $in: admin } }
      : { userId: new Types.ObjectId(userId) };
    const acts = cap(
      await AgentActivityModel.find({ ...filter, createdAt: range })
        .select("agentId outcome risk action createdAt")
        .limit(MAX_ROWS + 1)
        .lean(),
    );
    for (const a of acts) {
      const base = {
        u: String(a.agentId),
        s: null,
        t: new Date(a.createdAt).getTime(),
        p: {
          outcome: a.outcome,
          risk: a.risk,
          action: a.action,
          agent: String(a.agentId),
        },
      };
      if (wanted.has("agent_actions"))
        rows.push({ e: "agent_actions", ...base });
      if (wanted.has("agent_blocked") && a.outcome === "blocked")
        rows.push({ e: "agent_blocked", ...base });
      if (wanted.has("agent_held") && a.outcome === "pending_approval")
        rows.push({ e: "agent_held", ...base });
    }
  }

  const aiMetrics = ["ai_calls", "ai_cost", "ai_tokens"].filter((m) =>
    wanted.has(m),
  );
  if (aiMetrics.length) {
    const workspaceId = await agentService.defaultWorkspaceId(userId);
    const admin = await adminWorkspaces(userId);
    const workspaces = admin.length
      ? admin
      : workspaceId
        ? [new Types.ObjectId(workspaceId)]
        : [];
    const logs = cap(
      await PromptExecutionLogModel.find({
        workspaceId: { $in: workspaces },
        createdAt: range,
      })
        .select("createdAt totalCost totalTokens provider modelName agentId")
        .limit(MAX_ROWS + 1)
        .lean(),
    );
    for (const l of logs) {
      const base = {
        u: l.agentId ? String(l.agentId) : null,
        s: null,
        t: new Date(l.createdAt as Date).getTime(),
        p: {
          provider: l.provider,
          model: l.modelName,
          cost: Number(l.totalCost ?? 0),
          tokens: Number(l.totalTokens ?? 0),
        },
      };
      if (wanted.has("ai_calls")) rows.push({ e: "ai_calls", ...base });
      if (wanted.has("ai_cost")) rows.push({ e: "ai_cost", ...base });
      if (wanted.has("ai_tokens")) rows.push({ e: "ai_tokens", ...base });
    }
  }
  return { rows, truncated };
}

/* ------------------------------------------------------------------ */
/* Queries                                                              */
/* ------------------------------------------------------------------ */

const RANGES: Record<string, number> = {
  "1h": HOUR,
  "24h": DAY,
  "7d": 7 * DAY,
  "14d": 14 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
  "180d": 180 * DAY,
};

/** A time range from a preset ("7d") or explicit from/to (ISO or ms). Never more than 366 days. */
export function resolveRange(
  input: { range?: unknown; from?: unknown; to?: unknown },
  now = Date.now(),
): { from: number; to: number } {
  const parse = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  };
  let to = parse(input.to) ?? now;
  let from = parse(input.from);
  if (from == null)
    from = to - (RANGES[String(input.range ?? "7d")] ?? RANGES["7d"]);
  if (to > now) to = now;
  if (from >= to)
    throw new AppError(
      400,
      "The start of the range must be before its end",
      "BAD_REQUEST",
    );
  if (to - from > 366 * DAY)
    throw new AppError(400, "Choose a range of at most a year", "BAD_REQUEST");
  return { from, to };
}

const str = (v: unknown, max = 100): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function seriesFrom(
  raw: unknown,
  source: "events" | "pristine",
): TrendSeriesSpec[] {
  const list = Array.isArray(raw) ? raw.slice(0, 8) : [];
  const out = list
    .map((s) => s as Record<string, unknown>)
    .map((s) => ({
      event: str(s.event, 200) ?? "",
      math: (MATH_OPS.includes(s.math as MathOp)
        ? s.math
        : source === "pristine" &&
            (s.event === "ai_cost" || s.event === "ai_tokens")
          ? "sum"
          : "total") as MathOp,
      property:
        str(s.property) ??
        (source === "pristine" && s.event === "ai_cost"
          ? "cost"
          : source === "pristine" && s.event === "ai_tokens"
            ? "tokens"
            : null),
      filters: sanitizeFilters(s.filters),
      label: str(s.label, 120) ?? undefined,
    }))
    .filter(
      (s) => s.event && (source === "events" || PRISTINE_IDS.includes(s.event)),
    );
  for (const s of out) {
    if ((s.math === "sum" || s.math === "average") && !s.property)
      throw new AppError(
        400,
        `Choose the property to ${s.math === "sum" ? "add up" : "average"} for ${s.event}`,
        "BAD_REQUEST",
      );
  }
  return out;
}

export interface QueryInput {
  userId: string;
  kind: InsightKind;
  source: "events" | "pristine";
  integrationId?: string | null;
  query: Record<string, unknown>;
  range?: unknown;
  from?: unknown;
  to?: unknown;
  now?: number;
}

/** Runs one insight query and returns what the chart needs. */
export async function runQuery(input: QueryInput) {
  const q = input.query ?? {};
  // Days and weeks follow the viewer's clock: minutes east of UTC (e.g. 330 for India), as the browser reports it.
  const tz =
    Math.max(-840, Math.min(840, Math.round(Number(q.tzOffsetMinutes) || 0))) *
    60_000;
  const resolved = resolveRange(input, input.now);
  const to = resolved.to;
  let from = resolved.from;
  if (input.kind === "trends") {
    // Start on a whole bucket, so the first point is not a partial day that looks like a drop.
    const interval0: Interval = ["hour", "day", "week"].includes(
      String(q.interval),
    )
      ? (q.interval as Interval)
      : defaultInterval(from, to);
    from = bucketStart(from + tz, interval0) - tz;
  }
  const filters = sanitizeFilters(q.filters);
  const source = input.source === "pristine" ? "pristine" : "events";
  if (source === "pristine" && input.kind !== "trends")
    throw new AppError(
      400,
      "Pristine metrics can be shown as trends only",
      "BAD_REQUEST",
    );
  const integration =
    source === "events"
      ? await ownIntegration(input.userId, input.integrationId)
      : null;

  // Cohort filter: only people in the saved cohort.
  let cohortUsers: Set<string> | null = null;
  if (source === "events" && str(q.cohortId)) {
    const cohort = await CohortModel.findOne({
      _id: str(q.cohortId),
      ownerId: input.userId,
      integrationId: integration!.id,
    })
      .lean()
      .catch(() => null);
    if (!cohort) throw new AppError(404, "Cohort not found", "NOT_FOUND");
    cohortUsers = new Set(
      (
        await computeCohort(
          cohort.integrationId,
          cohort.definition as unknown as CohortDefinition,
          input.now,
        )
      ).members,
    );
  }

  const load = async (
    extraBefore: number,
    extraAfter: number,
    pristineMetrics: string[] = [],
  ) => {
    const lf = from - extraBefore;
    const lt = Math.min(to + extraAfter, input.now ?? Date.now());
    const data =
      source === "events"
        ? await loadEvents(integration!.id, lf, lt)
        : await loadPristine(input.userId, pristineMetrics, lf, lt);
    if (cohortUsers)
      data.rows = data.rows.filter((r) => r.u && cohortUsers!.has(r.u));
    return data;
  };

  if (input.kind === "trends") {
    const series = seriesFrom(q.series, source);
    if (!series.length)
      throw new AppError(
        400,
        source === "pristine" ? "Choose a metric" : "Choose at least one event",
        "BAD_REQUEST",
      );
    const interval: Interval = ["hour", "day", "week"].includes(
      String(q.interval),
    )
      ? (q.interval as Interval)
      : defaultInterval(from, to);
    if (interval === "hour" && to - from > 31 * DAY)
      throw new AppError(
        400,
        "Hourly points are available for up to 31 days",
        "BAD_REQUEST",
      );
    const data = await load(
      0,
      0,
      series.map((s) => s.event),
    );
    // "Compare to the previous period": the same query shifted back by the range length.
    let previous: number[] | null = null;
    if (q.compare === true) {
      const span = to - from;
      const prev =
        source === "events"
          ? await loadEvents(integration!.id, from - span, from - 1)
          : await loadPristine(
              input.userId,
              series.map((s) => s.event),
              from - span,
              from - 1,
            );
      const prevRows = cohortUsers
        ? prev.rows.filter((r) => r.u && cohortUsers!.has(r.u))
        : prev.rows;
      previous = trends(prevRows, {
        series,
        from: from - span,
        to: from - 1,
        interval,
        filters,
      }).series.map((s) => s.total);
    }
    const shifted = tz
      ? data.rows.map((r) => ({ ...r, t: r.t + tz }))
      : data.rows;
    const result = trends(shifted, {
      series,
      from: from + tz,
      to: to + tz,
      interval,
      breakdown: str(q.breakdown),
      filters,
    });
    // Bucket times back to real instants; the client shows them in the viewer's time zone.
    const unshift = (t: number) => t - tz;
    return {
      kind: "trends" as const,
      from,
      to,
      interval,
      truncated: data.truncated,
      ...result,
      buckets: result.buckets.map(unshift),
      series: result.series.map((x) => ({
        ...x,
        points: x.points.map((p) => ({ ...p, t: unshift(p.t) })),
      })),
      previousTotals: previous,
    };
  }

  if (input.kind === "funnel") {
    const steps = (Array.isArray(q.steps) ? q.steps : [])
      .map((s) => s as Record<string, unknown>)
      .map((s) => ({
        event: str(s.event, 200) ?? "",
        filters: sanitizeFilters(s.filters),
      }))
      .filter((s) => s.event)
      .slice(0, 10);
    if (steps.length < 2)
      throw new AppError(
        400,
        "A funnel needs at least two steps",
        "BAD_REQUEST",
      );
    const windowHours = Math.min(
      Math.max(Number(q.windowHours) || 24 * 7, 1),
      24 * 90,
    );
    // People who start near the end of the range still get their full window.
    const data = await load(0, windowHours * HOUR);
    // People enter inside the range; those who enter near its end still get their full window to finish.
    const result = funnel(data.rows, {
      steps,
      windowMs: windowHours * HOUR,
      from,
      to: to + windowHours * HOUR,
      entryTo: to,
      filters,
      by: q.by === "session" ? "session" : "user",
    });
    return {
      kind: "funnel" as const,
      from,
      to,
      windowHours,
      truncated: data.truncated,
      ...result,
    };
  }

  if (input.kind === "retention") {
    const startEvent = str(q.startEvent, 200);
    const returnEvent = str(q.returnEvent, 200) ?? startEvent;
    if (!startEvent || !returnEvent)
      throw new AppError(400, "Choose the start event", "BAD_REQUEST");
    const period = q.period === "week" ? "week" : "day";
    const periods = Math.min(
      Math.max(Number(q.periods) || (period === "day" ? 8 : 6), 2),
      24,
    );
    const len = period === "day" ? DAY : 7 * DAY;
    const data = await load(0, periods * len);
    const shifted = tz
      ? data.rows.map((r) => ({ ...r, t: r.t + tz }))
      : data.rows;
    const result = retention(shifted, {
      startEvent,
      returnEvent,
      period,
      periods,
      from: from + tz,
      to: to + tz,
      now: (input.now ?? Date.now()) + tz,
      filters,
    });
    return {
      kind: "retention" as const,
      from,
      to,
      period,
      periods,
      truncated: data.truncated,
      ...result,
      cohorts: result.cohorts.map((c) => ({ ...c, start: c.start - tz })),
    };
  }

  if (input.kind === "paths") {
    const depth = Math.min(Math.max(Number(q.depth) || 3, 1), 6);
    const data = await load(0, 0);
    return {
      kind: "paths" as const,
      from,
      to,
      depth,
      truncated: data.truncated,
      ...paths(data.rows, {
        startEvent: str(q.startEvent, 200),
        depth,
        from,
        to,
        filters,
      }),
    };
  }

  throw new AppError(400, "Unknown insight type", "BAD_REQUEST");
}

/** Event names and property keys seen recently, for the query builder's pickers. */
export async function schema(userId: string, integrationId: string, days = 30) {
  const integration = await ownIntegration(userId, integrationId);
  const now = Date.now();
  const { rows, truncated } = await loadEvents(
    integration.id,
    now - days * DAY,
    now,
  );
  const events = new Map<string, number>();
  const props = new Map<string, { count: number; samples: Set<string> }>();
  for (const r of rows) {
    events.set(r.e, (events.get(r.e) ?? 0) + 1);
    for (const [k, v] of Object.entries(r.p ?? {})) {
      if (v !== null && typeof v === "object") continue;
      const entry = props.get(k) ?? { count: 0, samples: new Set<string>() };
      entry.count += 1;
      if (entry.samples.size < 8 && v !== undefined && v !== "")
        entry.samples.add(String(v).slice(0, 60));
      props.set(k, entry);
    }
  }
  return {
    integration,
    truncated,
    users: new Set(rows.map((r) => r.u).filter(Boolean)).size,
    events: [...events.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    properties: [...props.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 100)
      .map(([name, v]) => ({ name, count: v.count, samples: [...v.samples] })),
  };
}

/* ------------------------------------------------------------------ */
/* Cohorts                                                              */
/* ------------------------------------------------------------------ */

export function sanitizeCohort(raw: unknown): CohortDefinition {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const rules = (Array.isArray(d.rules) ? d.rules : [])
    .slice(0, 10)
    .map((r) => r as Record<string, unknown>)
    .filter(
      (r) => (r.kind === "did" || r.kind === "did_not") && str(r.event, 200),
    )
    .map((r) => ({
      kind: r.kind as "did" | "did_not",
      event: str(r.event, 200) as string,
      count: Math.min(Math.max(Math.round(Number(r.count) || 1), 1), 10_000),
      withinDays: Math.min(
        Math.max(Math.round(Number(r.withinDays) || 30), 1),
        180,
      ),
      filters: sanitizeFilters(r.filters),
    }));
  const properties = sanitizeFilters(d.properties);
  if (!rules.length && !properties.length)
    throw new AppError(
      400,
      "Add at least one condition to the cohort",
      "BAD_REQUEST",
    );
  return { match: d.match === "any" ? "any" : "all", rules, properties };
}

/** Members of a cohort now. Reads as far back as its longest rule (at least 30 days, for property values). */
export async function computeCohort(
  integrationId: string,
  def: CohortDefinition,
  now = Date.now(),
) {
  const days = Math.max(30, ...def.rules.map((r) => r.withinDays));
  const { rows, truncated } = await loadEvents(
    integrationId,
    now - days * DAY,
    now,
  );
  return { members: cohortMembers(rows, def, now), truncated };
}

/* ------------------------------------------------------------------ */
/* Metric alerts                                                        */
/* ------------------------------------------------------------------ */

export function sanitizeAlertMetric(
  raw: unknown,
  source: "events" | "pristine",
): TrendSeriesSpec {
  const series = seriesFrom([raw], source);
  if (!series.length)
    throw new AppError(
      400,
      source === "pristine"
        ? "Choose a metric to watch"
        : "Choose the event to watch",
      "BAD_REQUEST",
    );
  return series[0];
}

/** The metric's value over the last window and the window before it. */
export async function measureAlert(
  alert: {
    ownerId: unknown;
    source: "events" | "pristine";
    integrationId?: string | null;
    metric: Record<string, unknown>;
    windowHours: number;
  },
  now = Date.now(),
) {
  const userId = String(alert.ownerId);
  const series = sanitizeAlertMetric(alert.metric, alert.source);
  const span = alert.windowHours * HOUR;
  const load = (from: number, to: number) =>
    alert.source === "events"
      ? loadEvents(String(alert.integrationId), from, to)
      : loadPristine(userId, [series.event], from, to);
  const [cur, prev] = await Promise.all([
    load(now - span, now),
    load(now - 2 * span, now - span - 1),
  ]);
  const value = (rows: EventRow[], from: number, to: number) =>
    trends(rows, { series: [series], from, to, interval: "hour" }).series[0]
      ?.total ?? 0;
  return {
    current: value(cur.rows, now - span, now),
    previous: value(prev.rows, now - 2 * span, now - span - 1),
  };
}

const alertTaskKey = (id: string) => `metric_alert:${id}`;

/** Checks one alert now: updates its state, opens a task when it starts firing and closes it when it recovers. */
export async function evaluateOne(
  alert: Awaited<ReturnType<typeof MetricAlertModel.findOne>> & object,
  now = Date.now(),
): Promise<"fired" | "recovered" | "unchanged" | "no_data"> {
  try {
    if (alert.source === "events")
      await ownIntegration(String(alert.ownerId), alert.integrationId);
    const { current, previous } = await measureAlert(
      alert.toObject() as never,
      now,
    );
    const { firing, detail } = evaluateAlert(
      { condition: alert.condition, threshold: alert.threshold },
      current,
      previous,
    );
    const wasFiring = alert.state === "firing";
    alert.lastValue = current;
    alert.lastDetail = detail;
    alert.lastEvaluatedAt = new Date(now);
    alert.state = firing ? "firing" : "ok";
    if (firing && !wasFiring) alert.lastFiredAt = new Date(now);
    await alert.save();

    const key = alertTaskKey(String(alert._id));
    const open = await AutomationLinkModel.findOne({ key, state: "open" });
    if (firing && !open) {
      const workspaceId = await agentService.defaultWorkspaceId(
        String(alert.ownerId),
      );
      await openTask(
        {
          rule: "metric_alert",
          key,
          title: `Alert: ${alert.name}`,
          description: `The alert "${alert.name}" fired: ${detail}, measured over the last ${alert.windowHours} hour${alert.windowHours === 1 ? "" : "s"}.`,
          priority: "HIGH",
          assigneeUserId: String(alert.ownerId),
          link: `/insights/alerts?alert=${alert._id}`,
        },
        workspaceId,
        { enabled: true, projectId: null } as never,
      );
      return "fired";
    }
    if (!firing && open) {
      await closeTask(open, `the metric is back to normal (${detail}).`);
      return "recovered";
    }
    return "unchanged";
  } catch (error) {
    alert.state = "no_data";
    alert.lastDetail = error instanceof Error ? error.message : String(error);
    alert.lastEvaluatedAt = new Date(now);
    await alert.save().catch(() => undefined);
    logger.warn("Metric alert could not be evaluated", {
      alertId: String(alert._id),
      message: alert.lastDetail,
    });
    return "no_data";
  }
}

/** Every enabled alert (scheduled every five minutes). */
export async function evaluateAlerts(
  now = Date.now(),
): Promise<{ checked: number; fired: number; recovered: number }> {
  const alerts = await MetricAlertModel.find({ enabled: true }).limit(2000);
  let fired = 0;
  let recovered = 0;
  for (const alert of alerts) {
    const r = await evaluateOne(alert, now);
    if (r === "fired") fired += 1;
    if (r === "recovered") recovered += 1;
  }
  return { checked: alerts.length, fired, recovered };
}

export const metricOptions = () => PRISTINE_METRICS.map((m) => ({ ...m }));
export type { PropertyFilter };
