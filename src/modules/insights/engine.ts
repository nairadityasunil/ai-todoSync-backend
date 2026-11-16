/**
 * Product analytics over SDK events: trends, funnels, retention, paths and
 * cohorts. Pure functions over rows already read from the database, so the
 * maths can be tested without one.
 */

export interface EventRow {
  /** Event name. */
  e: string;
  /** User id (null for anonymous events). */
  u: string | null;
  /** Session id. */
  s: string | null;
  /** Time, ms since epoch. */
  t: number;
  /** Event properties. */
  p: Record<string, unknown>;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "gt"
  | "lt"
  | "set"
  | "not_set";
export const FILTER_OPS: FilterOp[] = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "gt",
  "lt",
  "set",
  "not_set",
];

export interface PropertyFilter {
  property: string;
  op: FilterOp;
  value?: string | number | boolean | null;
}

export type Interval = "hour" | "day" | "week";
export type MathOp =
  | "total"
  | "unique_users"
  | "unique_sessions"
  | "sum"
  | "average";
export const MATH_OPS: MathOp[] = [
  "total",
  "unique_users",
  "unique_sessions",
  "sum",
  "average",
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Breakdowns keep this many values; the rest fold into "Other". */
export const MAX_BREAKDOWN_VALUES = 8;

/* ------------------------------------------------------------------ */
/* Properties and filters                                               */
/* ------------------------------------------------------------------ */

/** A property of an event: payload fields by name (dot paths allowed) plus $user and $session. */
export function propertyOf(row: EventRow, property: string): unknown {
  if (property === "$user") return row.u;
  if (property === "$session") return row.s;
  if (property === "$event") return row.e;
  let value: unknown = row.p;
  for (const part of property.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const asText = (value: unknown): string =>
  value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

export function matchesFilter(row: EventRow, filter: PropertyFilter): boolean {
  const value = propertyOf(row, filter.property);
  const present = value !== undefined && value !== null && value !== "";
  switch (filter.op) {
    case "set":
      return present;
    case "not_set":
      return !present;
    case "eq":
      return (
        present &&
        asText(value).toLowerCase() === asText(filter.value).toLowerCase()
      );
    case "neq":
      return (
        !present ||
        asText(value).toLowerCase() !== asText(filter.value).toLowerCase()
      );
    case "contains":
      return (
        present &&
        asText(value).toLowerCase().includes(asText(filter.value).toLowerCase())
      );
    case "not_contains":
      return (
        !present ||
        !asText(value)
          .toLowerCase()
          .includes(asText(filter.value).toLowerCase())
      );
    case "gt":
    case "lt": {
      const a = Number(value);
      const b = Number(filter.value);
      if (!present || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return filter.op === "gt" ? a > b : a < b;
    }
    default:
      return false;
  }
}

export const matchesAll = (
  row: EventRow,
  filters: PropertyFilter[] = [],
): boolean => filters.every((f) => matchesFilter(row, f));

/** Cleans filters from a request: known operators and a property name only. */
export function sanitizeFilters(raw: unknown): PropertyFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 20)
    .map((f) => f as Record<string, unknown>)
    .filter(
      (f) =>
        typeof f?.property === "string" &&
        f.property.trim() &&
        FILTER_OPS.includes(f.op as FilterOp),
    )
    .map((f) => ({
      property: String(f.property).trim().slice(0, 100),
      op: f.op as FilterOp,
      value:
        f.value == null
          ? null
          : typeof f.value === "number" || typeof f.value === "boolean"
            ? f.value
            : String(f.value).slice(0, 200),
    }));
}

/* ------------------------------------------------------------------ */
/* Time buckets                                                         */
/* ------------------------------------------------------------------ */

/** Start of the bucket a time falls in (UTC). Weeks start on Monday. */
export function bucketStart(t: number, interval: Interval): number {
  if (interval === "hour") return Math.floor(t / HOUR) * HOUR;
  const day = Math.floor(t / DAY) * DAY;
  if (interval === "day") return day;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - weekday * DAY;
}

/** Every bucket between from and to, so gaps show as zero instead of disappearing. */
export function buckets(
  from: number,
  to: number,
  interval: Interval,
): number[] {
  const out: number[] = [];
  const step = interval === "hour" ? HOUR : interval === "day" ? DAY : 7 * DAY;
  for (
    let b = bucketStart(from, interval);
    b <= to && out.length < 2000;
    b += step
  )
    out.push(b);
  return out;
}

/** A sensible interval for a range: hours up to two days, weeks beyond 90 days. */
export function defaultInterval(from: number, to: number): Interval {
  const span = to - from;
  if (span <= 2 * DAY) return "hour";
  if (span > 90 * DAY) return "week";
  return "day";
}

/* ------------------------------------------------------------------ */
/* Trends                                                               */
/* ------------------------------------------------------------------ */

export interface TrendSeriesSpec {
  event: string;
  math: MathOp;
  /** For sum and average: the numeric property. */
  property?: string | null;
  filters?: PropertyFilter[];
  label?: string;
}

export interface TrendSeries {
  key: string;
  label: string;
  event: string;
  breakdownValue: string | null;
  points: Array<{ t: number; value: number }>;
  total: number;
}

const counter = (math: MathOp, property?: string | null) => {
  if (math === "total") {
    let n = 0;
    return { add: () => void (n += 1), value: () => n };
  }
  if (math === "sum" || math === "average") {
    let sum = 0;
    let n = 0;
    return {
      add: (row: EventRow) => {
        const v = Number(property ? propertyOf(row, property) : NaN);
        if (!Number.isFinite(v)) return;
        sum += v;
        n += 1;
      },
      // Rounded to cents so money and durations read cleanly.
      value: () =>
        Math.round((math === "sum" ? sum : n ? sum / n : 0) * 100) / 100,
    };
  }
  const seen = new Set<string>();
  return {
    add: (row: EventRow) => {
      const id = math === "unique_users" ? row.u : row.s;
      if (id) seen.add(id);
    },
    value: () => seen.size,
  };
};

const MATH_SUFFIX: Record<MathOp, (property?: string | null) => string> = {
  total: () => "",
  unique_users: () => " (users)",
  unique_sessions: () => " (sessions)",
  sum: (p) => ` (sum of ${p ?? "?"})`,
  average: (p) => ` (average ${p ?? "?"})`,
};

/**
 * One line per series (and per breakdown value). Totals for unique counts are
 * counted over the whole range, not summed per bucket, so a person active on
 * three days is one user, not three.
 */
export function trends(
  rows: EventRow[],
  spec: {
    series: TrendSeriesSpec[];
    from: number;
    to: number;
    interval: Interval;
    breakdown?: string | null;
    filters?: PropertyFilter[];
  },
): { buckets: number[]; series: TrendSeries[]; otherFolded: number } {
  const times = buckets(spec.from, spec.to, spec.interval);
  const index = new Map(times.map((t, i) => [t, i]));
  const out: TrendSeries[] = [];
  let otherFolded = 0;

  spec.series.forEach((s, seriesIndex) => {
    const label =
      s.label?.trim() || `${s.event}${MATH_SUFFIX[s.math](s.property)}`;
    const matching = rows.filter(
      (r) =>
        (s.event === "$all" || r.e === s.event) &&
        r.t >= spec.from &&
        r.t <= spec.to &&
        matchesAll(r, spec.filters) &&
        matchesAll(r, s.filters),
    );

    // Breakdown values ranked by volume; the long tail folds into "Other".
    const groups = new Map<string, EventRow[]>();
    if (spec.breakdown) {
      for (const r of matching) {
        const v = propertyOf(r, spec.breakdown);
        const key =
          v === undefined || v === null || v === "" ? "(none)" : asText(v);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      const ranked = [...groups.entries()].sort(
        (a, b) => b[1].length - a[1].length,
      );
      if (ranked.length > MAX_BREAKDOWN_VALUES) {
        const kept = ranked.slice(0, MAX_BREAKDOWN_VALUES - 1);
        const rest = ranked.slice(MAX_BREAKDOWN_VALUES - 1);
        otherFolded = Math.max(otherFolded, rest.length);
        groups.clear();
        for (const [k, v] of kept) groups.set(k, v);
        groups.set(
          "Other",
          rest.flatMap(([, v]) => v),
        );
      }
    } else {
      groups.set("", matching);
    }

    for (const [value, groupRows] of groups) {
      const perBucket = times.map(() => counter(s.math, s.property));
      const total = counter(s.math, s.property);
      for (const r of groupRows) {
        const i = index.get(bucketStart(r.t, spec.interval));
        if (i === undefined) continue;
        perBucket[i].add(r);
        total.add(r);
      }
      out.push({
        key: `${seriesIndex}:${value}`,
        label: spec.breakdown ? `${label} · ${value}` : label,
        event: s.event,
        breakdownValue: spec.breakdown ? value : null,
        points: times.map((t, i) => ({ t, value: perBucket[i].value() })),
        total: total.value(),
      });
    }
  });
  return { buckets: times, series: out, otherFolded };
}

/* ------------------------------------------------------------------ */
/* Funnels                                                              */
/* ------------------------------------------------------------------ */

export interface FunnelStepResult {
  index: number;
  event: string;
  count: number;
  /** Share of people who started the funnel. */
  conversionFromStart: number;
  /** Share of people from the previous step. */
  conversionFromPrevious: number;
  dropped: number;
  /** Median ms from the previous step, for people who made it. */
  medianMsFromPrevious: number | null;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Ordered funnel per person: each step must happen after the previous one and
 * within the window of the first step. A person counts once, from their
 * earliest entry that gets furthest.
 */
export function funnel(
  rows: EventRow[],
  spec: {
    steps: Array<{ event: string; filters?: PropertyFilter[] }>;
    windowMs: number;
    from: number;
    to: number;
    filters?: PropertyFilter[];
    by?: "user" | "session";
    /** Latest time a person may enter (first step); later steps may run to `to`. Defaults to `to`. */ entryTo?: number;
  },
): { steps: FunnelStepResult[]; entered: number; converted: number } {
  const steps = spec.steps.slice(0, 10);
  if (steps.length < 2) return { steps: [], entered: 0, converted: 0 };
  const idOf = (r: EventRow) => (spec.by === "session" ? r.s : r.u);
  const people = new Map<string, EventRow[]>();
  for (const r of rows) {
    const id = idOf(r);
    if (!id || r.t < spec.from || r.t > spec.to || !matchesAll(r, spec.filters))
      continue;
    if (!steps.some((s) => s.event === r.e)) continue;
    if (!people.has(id)) people.set(id, []);
    people.get(id)!.push(r);
  }
  const reached = new Array<number>(steps.length).fill(0);
  const gaps: number[][] = steps.map(() => []);
  for (const events of people.values()) {
    events.sort((a, b) => a.t - b.t);
    let best: { depth: number; times: number[] } = { depth: 0, times: [] };
    for (const start of events) {
      if (start.e !== steps[0].event || !matchesAll(start, steps[0].filters))
        continue;
      if (start.t > (spec.entryTo ?? spec.to)) break;
      const times = [start.t];
      let depth = 1;
      for (const r of events) {
        if (depth >= steps.length) break;
        if (r.t < times[depth - 1] || r.t - start.t > spec.windowMs) continue;
        if (r === start) continue;
        if (r.e === steps[depth].event && matchesAll(r, steps[depth].filters)) {
          times.push(r.t);
          depth += 1;
        }
      }
      if (depth > best.depth) best = { depth, times };
      if (best.depth === steps.length) break;
    }
    for (let i = 0; i < best.depth; i += 1) {
      reached[i] += 1;
      if (i > 0) gaps[i].push(best.times[i] - best.times[i - 1]);
    }
  }
  const entered = reached[0];
  return {
    entered,
    converted: reached[steps.length - 1],
    steps: steps.map((s, i) => ({
      index: i,
      event: s.event,
      count: reached[i],
      conversionFromStart: entered ? reached[i] / entered : 0,
      conversionFromPrevious:
        i === 0
          ? entered
            ? 1
            : 0
          : reached[i - 1]
            ? reached[i] / reached[i - 1]
            : 0,
      dropped: i === 0 ? 0 : reached[i - 1] - reached[i],
      medianMsFromPrevious: i === 0 ? null : median(gaps[i]),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Retention                                                            */
/* ------------------------------------------------------------------ */

export interface RetentionCohortRow {
  start: number;
  size: number;
  /** Share of the cohort that came back in period 0, 1, 2… (null: period not over yet). */
  values: Array<number | null>;
  counts: Array<number | null>;
}

/**
 * People are grouped by the period they first did the start event. For each
 * later period, the share who did the return event in it. Period 0 is the
 * start period itself.
 */
export function retention(
  rows: EventRow[],
  spec: {
    startEvent: string;
    returnEvent: string;
    period: "day" | "week";
    periods: number;
    from: number;
    to: number;
    now?: number;
    filters?: PropertyFilter[];
  },
): { cohorts: RetentionCohortRow[]; average: Array<number | null> } {
  const periods = Math.max(1, Math.min(spec.periods, 24));
  const len = spec.period === "day" ? DAY : 7 * DAY;
  const now = spec.now ?? Date.now();
  const first = new Map<string, number>();
  const returns = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.u || !matchesAll(r, spec.filters)) continue;
    if (r.e === spec.startEvent && r.t >= spec.from && r.t <= spec.to) {
      const prev = first.get(r.u);
      if (prev === undefined || r.t < prev) first.set(r.u, r.t);
    }
    if (r.e === spec.returnEvent) {
      if (!returns.has(r.u)) returns.set(r.u, []);
      returns.get(r.u)!.push(r.t);
    }
  }
  const cohorts = new Map<number, string[]>();
  for (const [u, t] of first) {
    const start = bucketStart(t, spec.period);
    if (!cohorts.has(start)) cohorts.set(start, []);
    cohorts.get(start)!.push(u);
  }
  const out: RetentionCohortRow[] = [...cohorts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, users]) => {
      const counts: Array<number | null> = [];
      for (let p = 0; p < periods; p += 1) {
        const from = start + p * len;
        if (from > now) {
          counts.push(null);
          continue;
        }
        const to = from + len;
        let n = 0;
        for (const u of users) {
          const firstAt = first.get(u)!;
          // Period 0 counts a return at or after the person's own first start event.
          if (
            (returns.get(u) ?? []).some(
              (t) =>
                t >= from &&
                t < to &&
                t >= firstAt &&
                (p > 0 || spec.returnEvent !== spec.startEvent || t > firstAt),
            )
          )
            n += 1;
        }
        counts.push(n);
      }
      return {
        start,
        size: users.length,
        counts,
        values: counts.map((c) =>
          c == null ? null : users.length ? c / users.length : 0,
        ),
      };
    });
  const average: Array<number | null> = [];
  for (let p = 0; p < periods; p += 1) {
    let size = 0;
    let n = 0;
    for (const c of out) {
      if (c.counts[p] == null) continue;
      size += c.size;
      n += c.counts[p] as number;
    }
    average.push(size ? n / size : null);
  }
  return { cohorts: out, average };
}

/* ------------------------------------------------------------------ */
/* Paths                                                                */
/* ------------------------------------------------------------------ */

export interface PathEdge {
  step: number;
  from: string;
  to: string;
  count: number;
}

/**
 * What people do next: within each session, consecutive events from the start
 * event onward (repeats of the same event collapsed). The top edges per step.
 */
export function paths(
  rows: EventRow[],
  spec: {
    startEvent?: string | null;
    depth: number;
    from: number;
    to: number;
    filters?: PropertyFilter[];
    topPerStep?: number;
  },
): { edges: PathEdge[]; sessions: number } {
  const depth = Math.max(1, Math.min(spec.depth, 6));
  const top = spec.topPerStep ?? 8;
  const sessions = new Map<string, EventRow[]>();
  for (const r of rows) {
    const key = r.s ?? (r.u ? `u:${r.u}` : null);
    if (
      !key ||
      r.t < spec.from ||
      r.t > spec.to ||
      !matchesAll(r, spec.filters)
    )
      continue;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key)!.push(r);
  }
  const counts = new Map<string, number>();
  let used = 0;
  for (const events of sessions.values()) {
    events.sort((a, b) => a.t - b.t);
    const names: string[] = [];
    for (const r of events)
      if (names[names.length - 1] !== r.e) names.push(r.e);
    const startAt = spec.startEvent ? names.indexOf(spec.startEvent) : 0;
    if (startAt < 0 || names.length - startAt < 2) continue;
    used += 1;
    for (let i = 0; i < depth && startAt + i + 1 < names.length; i += 1) {
      const key = `${i}\u0000${names[startAt + i]}\u0000${names[startAt + i + 1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const edges = [...counts.entries()].map(([k, count]) => {
    const [step, from, to] = k.split("\u0000");
    return { step: Number(step), from, to, count };
  });
  const out: PathEdge[] = [];
  for (let i = 0; i < depth; i += 1) {
    out.push(
      ...edges
        .filter((e) => e.step === i)
        .sort((a, b) => b.count - a.count || a.to.localeCompare(b.to))
        .slice(0, top),
    );
  }
  return { edges: out, sessions: used };
}

/* ------------------------------------------------------------------ */
/* Cohorts                                                              */
/* ------------------------------------------------------------------ */

export interface CohortRule {
  /** did: did the event at least `count` times in the last `withinDays`; did_not: did not do it at all in that time. */
  kind: "did" | "did_not";
  event: string;
  count?: number;
  withinDays: number;
  filters?: PropertyFilter[];
}

export interface CohortDefinition {
  match: "all" | "any";
  rules: CohortRule[];
  /** Latest value of a user property, e.g. plan = pro. */
  properties?: PropertyFilter[];
}

/** People (user ids) who match a cohort, as of `now`. Only people seen in the rows can match. */
export function cohortMembers(
  rows: EventRow[],
  def: CohortDefinition,
  now = Date.now(),
): string[] {
  const byUser = new Map<string, EventRow[]>();
  for (const r of rows) {
    if (!r.u) continue;
    if (!byUser.has(r.u)) byUser.set(r.u, []);
    byUser.get(r.u)!.push(r);
  }
  const members: string[] = [];
  for (const [u, events] of byUser) {
    const ruleResults = def.rules.map((rule) => {
      const since = now - rule.withinDays * DAY;
      const n = events.filter(
        (r) =>
          r.e === rule.event &&
          r.t >= since &&
          r.t <= now &&
          matchesAll(r, rule.filters),
      ).length;
      return rule.kind === "did" ? n >= Math.max(1, rule.count ?? 1) : n === 0;
    });
    const rulesOk = !def.rules.length
      ? true
      : def.match === "all"
        ? ruleResults.every(Boolean)
        : ruleResults.some(Boolean);
    if (!rulesOk) continue;
    if (def.properties?.length) {
      // A person's properties are read from their most recent event that carries each one.
      const latest = [...events].sort((a, b) => b.t - a.t);
      const ok = def.properties.every((f) => {
        const carrier = latest.find(
          (r) => propertyOf(r, f.property) !== undefined,
        );
        return carrier
          ? matchesFilter(carrier, f)
          : f.op === "not_set" || f.op === "neq" || f.op === "not_contains";
      });
      if (!ok) continue;
    }
    members.push(u);
  }
  return members.sort();
}

/* ------------------------------------------------------------------ */
/* Alerts                                                               */
/* ------------------------------------------------------------------ */

export type AlertCondition = "above" | "below" | "change_up" | "change_down";

/**
 * Whether a metric breaches its rule. "change" rules compare the latest
 * window with the one before it, in percent.
 */
export function evaluateAlert(
  rule: { condition: AlertCondition; threshold: number },
  current: number,
  previous: number | null,
): { firing: boolean; detail: string } {
  switch (rule.condition) {
    case "above":
      return {
        firing: current > rule.threshold,
        detail: `${current} (threshold: above ${rule.threshold})`,
      };
    case "below":
      return {
        firing: current < rule.threshold,
        detail: `${current} (threshold: below ${rule.threshold})`,
      };
    case "change_up":
    case "change_down": {
      if (previous == null || previous === 0)
        return {
          firing: false,
          detail: `${current} (no earlier value to compare)`,
        };
      const change = ((current - previous) / previous) * 100;
      const firing =
        rule.condition === "change_up"
          ? change >= rule.threshold
          : -change >= rule.threshold;
      return {
        firing,
        detail: `${current}, ${change >= 0 ? "up" : "down"} ${Math.abs(Math.round(change))}% from ${previous} (threshold: ${rule.condition === "change_up" ? "up" : "down"} ${rule.threshold}%)`,
      };
    }
    default:
      return { firing: false, detail: "" };
  }
}
