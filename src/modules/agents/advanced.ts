/**
 * Advanced hybrid governance: behaviour baselines, cross-agent correlation,
 * session risk, data classification, just-in-time access, key lifecycle and
 * policy diffs. Pure functions (no database), so every rule is unit tested.
 */
import type { McpScope, RiskLevel } from "../mcp/registry/tool-types.js";
import type { RiskTier } from "./hybrid.js";

/* ------------------------------- Baselines ------------------------------ */

export interface BaselineStats {
  /** Days between the first and last observed action (activity span). */
  days: number;
  /** Changes observed in the window. */
  sample: number;
  /** Changes per active hour: median and 95th percentile. */
  hourlyP50: number;
  hourlyP95: number;
  /** Changes per active day: median and 95th percentile. */
  dailyP50: number;
  dailyP95: number;
  /** Actions and projects the agent normally uses. */
  actions: string[];
  projects: string[];
  /** Share of calls that failed or were blocked. */
  errorRate: number;
  /** Enough history (BASELINE_MIN_DAYS) to judge deviations. */
  ready: boolean;
}

export const BASELINE_MIN_DAYS = 7;
export const BASELINE_WINDOW_DAYS = 14;

export const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

export interface BaselineRow {
  at: Date;
  action: string;
  risk: string;
  outcome: string;
  projectId?: string | null;
}

/** Baseline from an agent's recent activity (changes only; reads are rarely logged). */
export function computeBaseline(rows: BaselineRow[], now = new Date()): BaselineStats {
  const changes = rows.filter((r) => r.risk !== "read");
  const hours = new Map<number, number>();
  const days = new Map<string, number>();
  const actions = new Map<string, number>();
  const projects = new Map<string, number>();
  let errors = 0;
  let first = now.getTime();
  for (const row of rows) {
    const t = row.at.getTime();
    if (t < first) first = t;
    if (row.outcome === "blocked" || row.outcome === "error") errors += 1;
    actions.set(row.action, (actions.get(row.action) ?? 0) + 1);
    if (row.projectId) projects.set(row.projectId, (projects.get(row.projectId) ?? 0) + 1);
  }
  for (const row of changes) {
    const hour = Math.floor(row.at.getTime() / 3600_000);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
    const day = row.at.toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const span = rows.length ? Math.floor((now.getTime() - first) / 86_400_000) : 0;
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    days: span,
    sample: changes.length,
    hourlyP50: percentile([...hours.values()], 50),
    hourlyP95: percentile([...hours.values()], 95),
    dailyP50: percentile([...days.values()], 50),
    dailyP95: percentile([...days.values()], 95),
    actions: top(actions, 100),
    projects: top(projects, 100),
    errorRate: rows.length ? Math.round((errors / rows.length) * 1000) / 1000 : 0,
    ready: span >= BASELINE_MIN_DAYS && rows.length >= 10,
  };
}

export interface AnomalyResult {
  /** 0-100: how far the call is from the agent's normal behaviour. */
  score: number;
  reasons: string[];
  /** Tier the action is raised to (null: no change). */
  boost: RiskTier | null;
  /** Current changes in the last hour against the usual hourly peak. */
  volumeRatio: number;
}

export const ANOMALY_RULES = {
  /** Changes in the last hour must be at least this many times the usual hourly peak. */
  volumeRatio: 4,
  /** ...and at least this many, so a quiet agent's third call is not an anomaly. */
  volumeMinimum: 10,
  holdScore: 30,
  highScore: 60,
} as const;

/** Compares one call with the agent's baseline. Reads are never scored. */
export function scoreAnomaly(
  baseline: Pick<BaselineStats, "ready" | "hourlyP95" | "actions" | "projects"> | null | undefined,
  current: { changesLastHour: number; action: string; projectId?: string | null; risk: RiskLevel },
): AnomalyResult {
  const none: AnomalyResult = { score: 0, reasons: [], boost: null, volumeRatio: 0 };
  if (!baseline?.ready || current.risk === "read") return none;
  let score = 0;
  const reasons: string[] = [];
  const usual = Math.max(1, baseline.hourlyP95);
  const ratio = current.changesLastHour / usual;
  if (ratio >= ANOMALY_RULES.volumeRatio && current.changesLastHour >= ANOMALY_RULES.volumeMinimum) {
    score += ratio >= ANOMALY_RULES.volumeRatio * 2 ? 60 : 40;
    reasons.push(`Volume is ${Math.round(ratio)}× baseline (${current.changesLastHour} changes in the last hour; usually up to ${usual})`);
  }
  if (!baseline.actions.includes(current.action)) {
    score += 20;
    reasons.push(`First time this agent runs ${current.action}`);
  }
  if (current.projectId && baseline.projects.length && !baseline.projects.includes(current.projectId)) {
    score += 15;
    reasons.push("A project this agent has not worked in before");
  }
  score = Math.min(100, score);
  const boost = score >= ANOMALY_RULES.highScore ? "high" : score >= ANOMALY_RULES.holdScore ? "medium" : null;
  return { score, reasons, boost, volumeRatio: Math.round(ratio * 10) / 10 };
}

/** Recent changes per agent, kept in memory (per process). */
export class ChangeCounter {
  private events = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Records one change and returns the count in the last hour (including it). */
  add(agentId: string): number {
    const cutoff = this.now() - 3600_000;
    const list = (this.events.get(agentId) ?? []).filter((t) => t >= cutoff);
    list.push(this.now());
    this.events.set(agentId, list.slice(-5000));
    if (this.events.size > 20_000) this.events.clear();
    return list.length;
  }

  count(agentId: string): number {
    const cutoff = this.now() - 3600_000;
    return (this.events.get(agentId) ?? []).filter((t) => t >= cutoff).length;
  }

  reset(agentId?: string): void {
    if (agentId) this.events.delete(agentId);
    else this.events.clear();
  }
}

/* ------------------------- Cross-agent correlation ------------------------ */

export type CorrelationClass = "people" | "export" | "delete";

/** Which sensitive kind of action a call is, for correlation (null: not sensitive). */
export function correlationClass(input: { action: string; risk: RiskLevel; isBulk: boolean }): CorrelationClass | null {
  if (input.risk === "destructive") return "delete";
  if (input.isBulk || /:export$|export/.test(input.action)) return "export";
  if (input.risk === "read" && /(member|user|invitation|people)[^:]*:(list|get)$/.test(input.action)) return "people";
  return null;
}

export interface CorrelationSignal {
  type: "coordinated_access" | "coordinated_delete";
  severity: "warning" | "critical";
  agentIds: string[];
  title: string;
  detail: string;
}

export const CORRELATION_RULES = {
  windowMs: 10 * 60_000,
  /** Distinct agents doing sensitive things in one workspace. */
  agents: 3,
  /** Distinct agents deleting in one project. */
  deleteAgents: 2,
} as const;

/** Sliding window per workspace of sensitive actions by different agents. */
export class CorrelationWindows {
  private events = new Map<string, Array<{ at: number; agentId: string; agentName: string; cls: CorrelationClass; projectId: string | null }>>();
  private fired = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  observe(input: { workspaceId: string; agentId: string; agentName: string; cls: CorrelationClass; projectId?: string | null }): CorrelationSignal[] {
    const r = CORRELATION_RULES;
    const cutoff = this.now() - r.windowMs;
    const list = (this.events.get(input.workspaceId) ?? []).filter((e) => e.at >= cutoff);
    list.push({ at: this.now(), agentId: input.agentId, agentName: input.agentName, cls: input.cls, projectId: input.projectId ?? null });
    this.events.set(input.workspaceId, list.slice(-2000));
    if (this.events.size > 20_000) this.events.clear();
    const out: CorrelationSignal[] = [];
    const fire = (key: string) => {
      const last = this.fired.get(key);
      if (last && this.now() - last < r.windowMs) return false;
      this.fired.set(key, this.now());
      return true;
    };
    const names = (ids: string[]) => ids.map((id) => list.find((e) => e.agentId === id)?.agentName ?? id);
    const agents = [...new Set(list.map((e) => e.agentId))];
    if (agents.length >= r.agents && agents.includes(input.agentId) && fire(`ws:${input.workspaceId}`)) {
      const kinds = [...new Set(list.map((e) => e.cls))];
      const label: Record<CorrelationClass, string> = { people: "listed people", export: "exported data", delete: "deleted records" };
      out.push({
        type: "coordinated_access",
        severity: kinds.includes("delete") || kinds.includes("export") ? "critical" : "warning",
        agentIds: agents,
        title: `Possible coordinated access by ${agents.length} agents`,
        detail: `${names(agents).join(", ")} ${kinds.map((k) => label[k]).join(", ")} within 10 minutes.`,
      });
    }
    if (input.cls === "delete" && input.projectId) {
      const deleters = [...new Set(list.filter((e) => e.cls === "delete" && e.projectId === input.projectId).map((e) => e.agentId))];
      if (deleters.length >= r.deleteAgents && fire(`del:${input.workspaceId}:${input.projectId}`)) {
        out.push({
          type: "coordinated_delete",
          severity: "critical",
          agentIds: deleters,
          title: `${deleters.length} agents are deleting in the same project`,
          detail: `${names(deleters).join(", ")} deleted records in one project within 10 minutes.`,
        });
      }
    }
    return out;
  }

  reset(): void {
    this.events.clear();
    this.fired.clear();
  }
}

/* ------------------------------ Session risk ----------------------------- */

export interface SessionSignals {
  /** The agent has a known set of addresses and this one is not in it. */
  newIp: boolean;
  /** The country (from a trusted proxy header) was not seen before. */
  newCountry: boolean;
  /** The owner's password changed or was reset recently. */
  credentialChange: boolean;
  /** The credential is in use from several addresses right now. */
  concurrent: boolean;
}

export interface SessionRisk {
  score: number;
  level: "normal" | "elevated" | "high";
  reasons: string[];
  boost: RiskTier | null;
}

export function sessionRisk(signals: SessionSignals): SessionRisk {
  let score = 0;
  const reasons: string[] = [];
  if (signals.newIp) {
    score += 25;
    reasons.push("Used from a network address not seen before");
  }
  if (signals.newCountry) {
    score += 40;
    reasons.push("Used from a new country");
  }
  // A password change alone is routine; it counts with a network signal.
  if (signals.credentialChange) {
    score += 20;
    reasons.push("Owner's password changed in the last 24 hours");
  }
  if (signals.concurrent) {
    score += 25;
    reasons.push("Used from several addresses at once");
  }
  const level = score >= 60 ? "high" : score >= 30 ? "elevated" : "normal";
  return { score: Math.min(100, score), level, reasons, boost: level === "high" ? "high" : level === "elevated" ? "medium" : null };
}

/* -------------------------- Data classification -------------------------- */

export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const DEFAULT_CLASSIFICATION: Classification = "internal";

const CLASS_RANK: Record<Classification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

export const isClassification = (value: unknown): value is Classification =>
  typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value);

/** A task's label, else its project's, else the default. */
export function effectiveClassification(task?: string | null, project?: string | null): Classification {
  if (isClassification(task)) return task;
  if (isClassification(project)) return project;
  return DEFAULT_CLASSIFICATION;
}

export const strictestClassification = (labels: Classification[]): Classification =>
  labels.reduce((a, b) => (CLASS_RANK[b] > CLASS_RANK[a] ? b : a), "public" as Classification);

export interface LabelVerdict {
  effect: "allow" | "require_approval" | "deny";
  boost: RiskTier | null;
  reason?: string;
}

/**
 * Stricter handling for labelled data. Confidential: changes need a person
 * in the enforce modes, and personal data never goes to an external model.
 * Restricted: nothing goes to an external model or leaves in bulk, and
 * changes are high risk.
 */
export function labelVerdict(input: {
  label: Classification;
  risk: RiskLevel;
  /** The call sends content to an AI provider. */
  toModel: boolean;
  /** Bulk export or a link to an unapproved host. */
  leaves: boolean;
  /** DLP findings in what is sent. */
  dlpFindings: number;
}): LabelVerdict {
  const { label } = input;
  const isRead = input.risk === "read";
  if (label === "restricted") {
    if (input.toModel) return { effect: "deny", boost: null, reason: "Blocked: restricted data never goes to an external model." };
    if (input.leaves) return { effect: "deny", boost: null, reason: "Blocked: restricted data cannot be exported or sent outside Pristine." };
    return { effect: "allow", boost: isRead ? null : "high" };
  }
  if (label === "confidential") {
    if (input.toModel && input.dlpFindings > 0) {
      return { effect: "deny", boost: null, reason: "Blocked: confidential data with personal or secret data cannot go to an external model." };
    }
    if (input.leaves) return { effect: "require_approval", boost: null, reason: "Held: confidential data is leaving Pristine." };
    return { effect: "allow", boost: isRead ? null : "medium" };
  }
  return { effect: "allow", boost: null };
}

/* --------------------------- Just-in-time access -------------------------- */

const READ_SCOPES: McpScope[] = ["work:read", "collaboration:read", "analytics:read", "prompt:read"];

/** Risk of granting these scopes for a while; workspace:admin is never granted just in time. */
export function elevationTier(scopes: McpScope[], agentRiskLevel?: string | null, isVendor = false): RiskTier | "forbidden" {
  if (scopes.includes("workspace:admin")) return "forbidden";
  let tier: RiskTier = scopes.every((s) => READ_SCOPES.includes(s)) ? "low" : "medium";
  if (agentRiskLevel === "high" || agentRiskLevel === "critical") tier = "high";
  if (isVendor && tier === "low") tier = "medium";
  return tier;
}

export const clampMinutes = (value: unknown, max: number, fallback = 30): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(max, Math.max(5, n));
};

/* ------------------------------ Key lifecycle ----------------------------- */

export type RotationStep = "none" | "notify" | "rotate" | "confirm";

/**
 * What to do with a key of this age: warn the owner in the last week (or
 * tenth of its life), rotate it a day before it is due (low and medium risk
 * keys, automatic mode), or ask a person to confirm (high risk keys).
 */
export function rotationStep(input: {
  issuedAt: Date;
  maxAgeDays: number;
  mode: "off" | "notify" | "auto";
  riskLevel?: string | null;
  alreadyNotified: boolean;
  isVendor?: boolean;
  now?: Date;
}): RotationStep {
  if (input.mode === "off" || input.maxAgeDays <= 0) return "none";
  const now = (input.now ?? new Date()).getTime();
  const dueAt = input.issuedAt.getTime() + input.maxAgeDays * 86_400_000;
  const warnDays = Math.max(1, Math.min(7, Math.round(input.maxAgeDays / 10)));
  if (now < dueAt - warnDays * 86_400_000) return "none";
  if (input.mode === "auto" && now >= dueAt - 86_400_000) {
    const risky = input.riskLevel === "high" || input.riskLevel === "critical" || input.isVendor;
    if (risky) return input.alreadyNotified ? "none" : "confirm";
    return "rotate";
  }
  return input.alreadyNotified ? "none" : "notify";
}

/* ------------------------------ Policy diffs ------------------------------ */

export interface PolicySnapshot {
  name: string;
  description?: string;
  effect: string;
  mode: string;
  priority: number;
  enabled: boolean;
  match: Record<string, unknown>;
}

export interface PolicyChange {
  field: string;
  before: unknown;
  after: unknown;
}

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length ? [...value].map(String).sort() : undefined;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, normalizeValue(v)] as const)
      .filter(([, v]) => v !== undefined && v !== null && v !== "");
    return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) : undefined;
  }
  return value === null || value === "" ? undefined : value;
};

/** Field-by-field differences between two policy versions (match fields flattened). */
export function diffPolicies(before: PolicySnapshot | null, after: PolicySnapshot | null): PolicyChange[] {
  const flat = (p: PolicySnapshot | null): Record<string, unknown> => {
    if (!p) return {};
    const out: Record<string, unknown> = {
      name: p.name,
      description: p.description || undefined,
      effect: p.effect,
      mode: p.mode,
      priority: p.priority,
      enabled: p.enabled,
    };
    for (const [key, value] of Object.entries(p.match ?? {})) out[`match.${key}`] = normalizeValue(value);
    return out;
  };
  const a = flat(before);
  const b = flat(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map((key) => ({ field: key, before: a[key] ?? null, after: b[key] ?? null }));
}

/* ------------------------------- Simulation ------------------------------- */

export type Effect = "allow" | "deny" | "require_approval";

export interface SimulationSummary {
  total: number;
  current: Record<Effect, number>;
  proposed: Record<Effect, number>;
  /** Calls the change would decide differently, by transition, e.g. "allow→require_approval". */
  changed: Record<string, number>;
}

export function summarizeSimulation(rows: Array<{ before: Effect; after: Effect }>): SimulationSummary {
  const zero = (): Record<Effect, number> => ({ allow: 0, deny: 0, require_approval: 0 });
  const summary: SimulationSummary = { total: rows.length, current: zero(), proposed: zero(), changed: {} };
  for (const row of rows) {
    summary.current[row.before] += 1;
    summary.proposed[row.after] += 1;
    if (row.before !== row.after) {
      const key = `${row.before}→${row.after}`;
      summary.changed[key] = (summary.changed[key] ?? 0) + 1;
    }
  }
  return summary;
}

/* -------------------------------- Playbooks ------------------------------- */

export const PLAYBOOK_STEP_TYPES = [
  "suspend_agent",
  "require_reapproval",
  "create_incident",
  "notify",
  "wait_for_approval",
  "revoke_agent",
] as const;
export type PlaybookStepType = (typeof PLAYBOOK_STEP_TYPES)[number];

export const PLAYBOOK_TRIGGERS = [
  "threat",
  "dlp",
  "anomaly",
  "coordinated_access",
  "compliance_drift",
  "critical_risk",
  "unregistered_agent",
  "key_rotation_due",
] as const;

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

/** Whether a playbook's trigger matches an alert. */
export function playbookMatches(
  trigger: { types: string[]; minSeverity: "info" | "warning" | "critical" },
  alert: { type: string; severity: "info" | "warning" | "critical" },
): boolean {
  return trigger.types.includes(alert.type) && SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[trigger.minSeverity];
}

export const PLAYBOOK_TEMPLATES: Array<{
  key: string;
  name: string;
  description: string;
  trigger: { types: string[]; minSeverity: "info" | "warning" | "critical" };
  steps: PlaybookStepType[];
}> = [
  {
    key: "critical_threat",
    name: "Critical threat",
    description: "Suspend the agent, open an incident and notify security; a person then confirms a permanent revoke.",
    trigger: { types: ["threat", "coordinated_access"], minSeverity: "critical" },
    steps: ["suspend_agent", "create_incident", "notify", "wait_for_approval", "revoke_agent"],
  },
  {
    key: "data_leak",
    name: "Sensitive data leaving",
    description: "On a critical DLP finding, the agent's next change needs a person, and security is notified.",
    trigger: { types: ["dlp"], minSeverity: "critical" },
    steps: ["require_reapproval", "notify"],
  },
  {
    key: "anomaly",
    name: "Unusual behaviour",
    description: "When an agent strays far from its baseline, its next change needs a person.",
    trigger: { types: ["anomaly"], minSeverity: "warning" },
    steps: ["require_reapproval", "notify"],
  },
  {
    key: "compliance_drift",
    name: "Compliance drift",
    description: "Open an incident and notify the compliance owner when a control slips.",
    trigger: { types: ["compliance_drift"], minSeverity: "warning" },
    steps: ["create_incident", "notify"],
  },
];
