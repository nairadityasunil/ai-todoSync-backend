import type { RiskLevel } from "../mcp/registry/tool-types.js";
import type {
  AgentKind,
  IPolicyMatch,
  PolicyEffect,
  PolicyMode,
} from "./model.js";

/** Risk levels in increasing order of impact. */
export const RISK_ORDER: RiskLevel[] = [
  "read",
  "write",
  "sensitive_write",
  "destructive",
  "security_critical",
];

export const riskRank = (risk: RiskLevel): number => RISK_ORDER.indexOf(risk);

export interface PolicyLike {
  id: string;
  name: string;
  effect: PolicyEffect;
  mode: PolicyMode;
  priority: number;
  enabled: boolean;
  match: IPolicyMatch;
}

export interface PolicyContext {
  agentId: string;
  agentKind: AgentKind;
  action: string;
  domain: string;
  risk: RiskLevel;
  projectId?: string | null;
  now?: Date;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** The enforced policy that decided, if any. */
  policy: PolicyLike | null;
  /** Advisory policies that matched (logged, never enforced). */
  advisory: PolicyLike[];
}

const globCache = new Map<string, RegExp>();

/** Glob match where "*" stands for any run of characters ("task:*", "*:delete"). */
export const globMatch = (pattern: string, value: string): boolean => {
  let regex = globCache.get(pattern);
  if (!regex) {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    regex = new RegExp(`^${source}$`);
    globCache.set(pattern, regex);
  }
  return regex.test(value);
};

const matchesName = (patterns: string[] | undefined, value: string): boolean =>
  !patterns ||
  patterns.length === 0 ||
  patterns.some((pattern) => globMatch(pattern, value));

const matchesList = <T>(
  list: T[] | undefined,
  value: T | null | undefined,
): boolean =>
  !list || list.length === 0 || (value != null && list.includes(value));

/** Hour and weekday of `now` in an IANA timezone (falls back to UTC). */
export function localTime(
  now: Date,
  timezone?: string,
): { day: number; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    const hour = Number(
      parts.find((p) => p.type === "hour")?.value ?? now.getUTCHours(),
    );
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      weekday,
    );
    return { day, hour };
  } catch {
    return { day: now.getUTCDay(), hour: now.getUTCHours() };
  }
}

function matchesTimeWindow(
  window: IPolicyMatch["timeWindow"],
  now: Date,
): boolean {
  if (!window) return true;
  const { day, hour } = localTime(now, window.timezone);
  const start = window.startHour ?? 0;
  const end = window.endHour ?? 24;
  const inHours =
    start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  const inDays =
    !window.days || window.days.length === 0 || window.days.includes(day);
  const inside = inHours && inDays;
  return window.outside ? !inside : inside;
}

export function policyMatches(
  policy: PolicyLike,
  context: PolicyContext,
): boolean {
  const match = policy.match ?? {};
  if (!policy.enabled) return false;
  if (!matchesList(match.agentKinds, context.agentKind)) return false;
  if (!matchesList(match.agentIds, context.agentId)) return false;
  if (!matchesName(match.tools, context.action)) return false;
  if (!matchesList(match.domains, context.domain)) return false;
  if (match.minRisk && riskRank(context.risk) < riskRank(match.minRisk))
    return false;
  if (match.projectIds && match.projectIds.length > 0) {
    if (!context.projectId || !match.projectIds.includes(context.projectId))
      return false;
  }
  if (!matchesTimeWindow(match.timeWindow, context.now ?? new Date()))
    return false;
  return true;
}

/**
 * Highest priority first; the first enforced match decides. Ties go to the
 * stricter effect (deny > require_approval > allow). No match means allow.
 */
export function evaluatePolicies(
  policies: PolicyLike[],
  context: PolicyContext,
): PolicyDecision {
  const strictness: Record<PolicyEffect, number> = {
    deny: 2,
    require_approval: 1,
    allow: 0,
  };
  const ordered = [...policies].sort(
    (a, b) =>
      b.priority - a.priority || strictness[b.effect] - strictness[a.effect],
  );
  const advisory: PolicyLike[] = [];
  for (const policy of ordered) {
    if (!policyMatches(policy, context)) continue;
    if (policy.mode === "advisory") {
      if (policy.effect !== "allow") advisory.push(policy);
      continue;
    }
    return { effect: policy.effect, policy, advisory };
  }
  return { effect: "allow", policy: null, advisory };
}
