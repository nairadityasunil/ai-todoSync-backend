/**
 * Hybrid governance: autonomous where risk is low, a person where it matters.
 * Pure functions (no database), so every rule here is unit tested.
 */
import type { RiskLevel } from "../mcp/registry/tool-types.js";

export type GovernanceMode = "advisory" | "auto_low_risk" | "full_enforce";
export type DlpMode = "off" | "monitor" | "enforce";
export type ReportSchedule = "off" | "weekly" | "monthly";
export type RiskTier = "low" | "medium" | "high" | "critical";

export interface GovernanceSettings {
  /** What happens when no explicit policy matches an agent action. */
  mode: GovernanceMode;
  /** Auto-approve when a person approved the same agent + action within this many days (0: off). */
  autoApproveRepeatDays: number;
  /** Suspend an agent at once when an action is critical risk or a critical threat is seen. */
  criticalAutoSuspend: boolean;
  dlpMode: DlpMode;
  threatDetection: boolean;
  /** Open an incident and suspend the agent on critical threats. */
  incidentAutoContain: boolean;
  /** Agent keys older than this fail compliance (and are blocked in enforce mode). */
  keyMaxAgeDays: number;
  /** Block agent changes that would break a compliance control (e.g. expired keys). */
  complianceEnforce: boolean;
  complianceReportSchedule: ReportSchedule;
  /** Regions data may be processed in (vendor data location); empty: not restricted. */
  allowedDataRegions: string[];
}

/** Defaults for new workspaces (the hybrid model). */
export const NEW_WORKSPACE_GOVERNANCE: GovernanceSettings = {
  mode: "auto_low_risk",
  autoApproveRepeatDays: 0,
  criticalAutoSuspend: true,
  dlpMode: "enforce",
  threatDetection: true,
  incidentAutoContain: true,
  keyMaxAgeDays: 90,
  complianceEnforce: false,
  complianceReportSchedule: "off",
  allowedDataRegions: [],
};

/**
 * Workspaces created before hybrid governance keep their behaviour (actions no
 * policy covers are allowed and only logged) until an admin picks a mode.
 * Detection, DLP monitoring and threat alerts are on for everyone.
 */
export const EXISTING_WORKSPACE_GOVERNANCE: GovernanceSettings = {
  ...NEW_WORKSPACE_GOVERNANCE,
  mode: "advisory",
  dlpMode: "monitor",
  criticalAutoSuspend: false,
  incidentAutoContain: true,
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const intIn = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Stored settings (possibly partial or missing) with defaults filled in. */
export function normalizeGovernance(stored: unknown): GovernanceSettings {
  if (!stored || typeof stored !== "object") return { ...EXISTING_WORKSPACE_GOVERNANCE };
  const s = stored as Record<string, unknown>;
  const base = EXISTING_WORKSPACE_GOVERNANCE;
  return {
    mode: oneOf(s.mode, ["advisory", "auto_low_risk", "full_enforce"] as const, base.mode),
    autoApproveRepeatDays: intIn(s.autoApproveRepeatDays, 0, 90, base.autoApproveRepeatDays),
    criticalAutoSuspend: typeof s.criticalAutoSuspend === "boolean" ? s.criticalAutoSuspend : base.criticalAutoSuspend,
    dlpMode: oneOf(s.dlpMode, ["off", "monitor", "enforce"] as const, base.dlpMode),
    threatDetection: typeof s.threatDetection === "boolean" ? s.threatDetection : base.threatDetection,
    incidentAutoContain: typeof s.incidentAutoContain === "boolean" ? s.incidentAutoContain : base.incidentAutoContain,
    keyMaxAgeDays: intIn(s.keyMaxAgeDays, 0, 3650, base.keyMaxAgeDays),
    complianceEnforce: typeof s.complianceEnforce === "boolean" ? s.complianceEnforce : base.complianceEnforce,
    complianceReportSchedule: oneOf(s.complianceReportSchedule, ["off", "weekly", "monthly"] as const, base.complianceReportSchedule),
    allowedDataRegions: Array.isArray(s.allowedDataRegions)
      ? s.allowedDataRegions.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim().slice(0, 40)).slice(0, 20)
      : base.allowedDataRegions,
  };
}

/* ------------------------------ Risk tiers ------------------------------ */

const TIER_ORDER: Record<RiskTier, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const maxTier = (...tiers: RiskTier[]): RiskTier =>
  tiers.reduce((a, b) => (TIER_ORDER[b] > TIER_ORDER[a] ? b : a), "low" as RiskTier);

/** How risky the action itself is. */
export function actionTier(risk: RiskLevel): RiskTier {
  switch (risk) {
    case "read":
    case "write":
      return "low";
    case "sensitive_write":
      return "medium";
    case "destructive":
    case "security_critical":
      return "high";
    default:
      return "medium";
  }
}

/**
 * The tier of one agent action: the riskier of the action and the agent's own
 * risk level when that is high or critical. A critical agent's writes are critical; its reads stay as they are
 * (looking is not acting), unless the agent is critical and the read is bulk.
 */
export function tierFor(input: { risk: RiskLevel; agentRiskLevel?: string | null; boost?: RiskTier | null }): RiskTier {
  const agentLevel = (["low", "medium", "high", "critical"] as const).includes(input.agentRiskLevel as RiskTier)
    ? (input.agentRiskLevel as RiskTier)
    : "low";
  const fromAction = actionTier(input.risk);
  // A medium agent score is normal for any key that can write; only high and critical agents raise the tier.
  const fromAgent = input.risk === "read" ? (agentLevel === "critical" ? "medium" : "low") : agentLevel === "medium" ? "low" : agentLevel;
  return maxTier(fromAction, fromAgent, input.boost ?? "low");
}

export interface DefaultDecision {
  effect: "allow" | "require_approval" | "deny";
  /** Suspend the agent (critical tier with auto-suspend on). */
  suspend: boolean;
  /** Human-readable rule, shown as "System decided: …". */
  rule: string;
  /** Advisory mode: what enforcement would have done. */
  wouldHave?: "require_approval" | "deny";
}

/** What the system decides when no explicit policy matches. */
export function defaultDecision(settings: Pick<GovernanceSettings, "mode" | "criticalAutoSuspend">, tier: RiskTier, isRead: boolean): DefaultDecision {
  const label = `${tier} risk`;
  if (settings.mode === "advisory") {
    const would = tier === "low" ? undefined : tier === "critical" ? "deny" : "require_approval";
    return { effect: "allow", suspend: false, rule: `Default rule (advisory): ${label}, allowed and logged`, wouldHave: would };
  }
  if (tier === "critical") {
    return {
      effect: "deny",
      suspend: settings.criticalAutoSuspend,
      rule: settings.criticalAutoSuspend ? `Default rule: ${label}, blocked and agent suspended for review` : `Default rule: ${label}, blocked`,
    };
  }
  if (tier === "low" && (settings.mode === "auto_low_risk" || isRead)) {
    return { effect: "allow", suspend: false, rule: `Default rule: ${label}, allowed automatically` };
  }
  if (settings.mode === "full_enforce" && isRead) {
    return { effect: "allow", suspend: false, rule: `Default rule: ${label} read, allowed` };
  }
  return { effect: "require_approval", suspend: false, rule: `Default rule: ${label}, needs a person` };
}

/* --------------------------- Recommendations --------------------------- */

export interface Recommendation {
  decision: "approve" | "reject";
  reasons: string[];
}

/** The system's suggested decision for a held action, with its reasons. */
export function recommend(input: {
  tier: RiskTier;
  risk: RiskLevel;
  agentRiskLevel?: string | null;
  agentKind: string;
  approvedBefore: number;
  rejectedBefore: number;
  dlpFindings: number;
  threatSignals: number;
}): Recommendation {
  const reasons: string[] = [];
  let score = 0;
  if (input.tier === "low") {
    score += 1;
    reasons.push("Low-risk action");
  }
  if (input.tier === "high" || input.tier === "critical") {
    score -= 1;
    reasons.push(`${input.tier[0].toUpperCase()}${input.tier.slice(1)}-risk action`);
  }
  if (input.risk === "destructive") {
    score -= 1;
    reasons.push("Deletes data, which cannot always be undone");
  }
  if (input.agentKind === "detected") {
    score -= 1;
    reasons.push("Unregistered agent using a person's login");
  }
  if (input.agentRiskLevel === "high" || input.agentRiskLevel === "critical") {
    score -= 1;
    reasons.push(`Agent risk is ${input.agentRiskLevel}`);
  }
  if (input.approvedBefore > 0) {
    score += 2;
    reasons.push(`A person approved this action for this agent ${input.approvedBefore} time(s) recently`);
  }
  if (input.rejectedBefore > 0) {
    score -= 2;
    reasons.push(`A person rejected this action for this agent ${input.rejectedBefore} time(s) recently`);
  }
  if (input.dlpFindings > 0) {
    score -= 2;
    reasons.push("Contains sensitive data (DLP)");
  }
  if (input.threatSignals > 0) {
    score -= 2;
    reasons.push("Agent has recent threat signals");
  }
  return { decision: score > 0 ? "approve" : "reject", reasons: reasons.length ? reasons : ["No strong signal either way"] };
}

/* ---------------------------------- DLP --------------------------------- */

export type DlpFindingType = "credential" | "card_number" | "email" | "phone" | "national_id" | "bulk_export" | "external_destination";
export interface DlpFinding {
  type: DlpFindingType;
  label: string;
  confidence: "high" | "medium";
  count: number;
}

const CREDENTIAL = /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bpk_agent_[A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?<![\w.])\+?[\d(][\d\s().-]{8,}\d(?![\w.])/g;
const US_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const URL = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;

/** Luhn check, so order numbers and ids are not mistaken for card numbers. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const collectStrings = (value: unknown, out: string[], depth = 0): void => {
  if (depth > 6 || out.length > 2000) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out, depth + 1));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => collectStrings(v, out, depth + 1));
};

/**
 * Scans what an agent sends (request body, tool input, AI prompt) for secrets
 * and personal data, and for links to hosts outside the allowed list.
 */
export function scanForDlp(value: unknown, options: { allowedHosts?: string[] } = {}): DlpFinding[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  const text = strings.join("\n").slice(0, 200_000);
  const findings: DlpFinding[] = [];
  const add = (type: DlpFindingType, label: string, confidence: "high" | "medium", count: number) => {
    if (count > 0) findings.push({ type, label, confidence, count });
  };
  add("credential", "API key, token or private key", "high", (text.match(CREDENTIAL) ?? []).length);
  add("card_number", "Payment card number", "high", (text.match(CARD) ?? []).filter((c) => luhn(c.replace(/\D/g, ""))).length);
  add("national_id", "National ID number", "high", (text.match(US_SSN) ?? []).length);
  const emails = new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  add("email", "Email address", "medium", emails.size);
  const phones = (text.match(PHONE) ?? []).filter((p) => !/^\d{4}-\d{2}-\d{2}/.test(p) && p.replace(/\D/g, "").length >= 9);
  add("phone", "Phone number", "medium", phones.length);
  if (options.allowedHosts) {
    const allowed = options.allowedHosts.map((h) => h.toLowerCase());
    const external = new Set<string>();
    for (const match of text.matchAll(URL)) {
      const host = match[1].toLowerCase();
      if (!allowed.some((a) => host === a || host.endsWith(`.${a}`))) external.add(host);
    }
    add("external_destination", `Link to an unapproved host (${[...external].slice(0, 3).join(", ")})`, "medium", external.size);
  }
  return findings;
}

/** Bulk reads that move a lot of data at once: exports, or very large pages. */
export function isBulkRead(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (/\/export\b|\/all-logs\b|\/evidence\b/.test(path)) return true;
  const limit = Number(/[?&]limit=(\d+)/.exec(path)?.[1] ?? 0);
  return limit >= 500;
}

export interface DlpVerdict {
  effect: "allow" | "require_approval" | "deny";
  reason?: string;
}

/** What DLP does about the findings, by mode. */
export function dlpVerdict(mode: DlpMode, findings: DlpFinding[]): DlpVerdict {
  if (mode !== "enforce" || findings.length === 0) return { effect: "allow" };
  const high = findings.filter((f) => f.confidence === "high");
  if (high.length) return { effect: "deny", reason: `Blocked by DLP: contains ${high.map((f) => f.label.toLowerCase()).join(", ")}.` };
  return { effect: "require_approval", reason: `Held by DLP: contains ${findings.map((f) => f.label.toLowerCase()).join(", ")}.` };
}

/* -------------------------------- Threats ------------------------------- */

export type ThreatType = "key_abuse" | "privilege_escalation" | "rapid_enumeration" | "exfiltration" | "mass_delete" | "repeated_blocks";

export interface ThreatSignal {
  type: ThreatType;
  severity: "warning" | "critical";
  title: string;
  detail: string;
}

export const THREAT_RULES = {
  keyAbuseIps: 3,
  keyAbuseWindowMs: 10 * 60_000,
  escalationAttempts: 3,
  escalationWindowMs: 10 * 60_000,
  enumerationReads: 60,
  enumerationWindowMs: 5 * 60_000,
  bulkReads: 5,
  bulkWindowMs: 15 * 60_000,
  massDeletes: 5,
  massDeleteWindowMs: 5 * 60_000,
  blocks: 5,
  blocksWindowMs: 10 * 60_000,
} as const;

/** Sliding windows of recent events per agent, kept in memory (per process). */
export class ThreatWindows {
  private events = new Map<string, Array<{ at: number; kind: string; value?: string }>>();

  constructor(private readonly now: () => number = Date.now) {}

  private push(agentId: string, kind: string, value?: string) {
    const list = this.events.get(agentId) ?? [];
    list.push({ at: this.now(), kind, value });
    // Keep at most the last 15 minutes and 500 entries per agent.
    const cutoff = this.now() - 15 * 60_000;
    const trimmed = list.filter((e) => e.at >= cutoff).slice(-500);
    this.events.set(agentId, trimmed);
    if (this.events.size > 20_000) this.events.clear();
  }

  private count(agentId: string, kind: string, windowMs: number): Array<{ value?: string }> {
    const cutoff = this.now() - windowMs;
    return (this.events.get(agentId) ?? []).filter((e) => e.kind === kind && e.at >= cutoff);
  }

  /** Records one call and returns the threats it completes (each only when its threshold is first reached). */
  observe(input: {
    agentId: string;
    agentName: string;
    ip?: string | null;
    risk: RiskLevel;
    isList: boolean;
    isBulk: boolean;
    outcome?: "blocked" | "escalation" | null;
  }): ThreatSignal[] {
    const r = THREAT_RULES;
    const out: ThreatSignal[] = [];
    const { agentId, agentName } = input;
    if (input.ip) {
      const before = new Set(this.count(agentId, "ip", r.keyAbuseWindowMs).map((e) => e.value)).size;
      this.push(agentId, "ip", input.ip);
      const ips = new Set(this.count(agentId, "ip", r.keyAbuseWindowMs).map((e) => e.value));
      if (ips.size === r.keyAbuseIps && before < r.keyAbuseIps) {
        out.push({ type: "key_abuse", severity: "critical", title: `${agentName} is used from ${ips.size} addresses`, detail: `The same credential was used from ${[...ips].join(", ")} within 10 minutes. It may be leaked.` });
      }
    }
    const crossing = (kind: string, threshold: number, windowMs: number): boolean => {
      this.push(agentId, kind);
      return this.count(agentId, kind, windowMs).length === threshold;
    };
    if (input.outcome === "escalation" && crossing("escalation", r.escalationAttempts, r.escalationWindowMs)) {
      out.push({ type: "privilege_escalation", severity: "warning", title: `${agentName} keeps trying actions it is not allowed`, detail: `${r.escalationAttempts} attempts to use scopes or people-only actions within 10 minutes.` });
    }
    if (input.outcome === "blocked" && crossing("blocked", r.blocks, r.blocksWindowMs)) {
      out.push({ type: "repeated_blocks", severity: "critical", title: `${agentName} was blocked ${r.blocks} times in 10 minutes`, detail: "Repeated blocked actions usually mean a misbehaving or compromised agent." });
    }
    if (input.isList && crossing("list", r.enumerationReads, r.enumerationWindowMs)) {
      out.push({ type: "rapid_enumeration", severity: "warning", title: `${agentName} is listing records rapidly`, detail: `${r.enumerationReads} list calls within 5 minutes.` });
    }
    if (input.isBulk && crossing("bulk", r.bulkReads, r.bulkWindowMs)) {
      out.push({ type: "exfiltration", severity: "critical", title: `${agentName} is exporting data repeatedly`, detail: `${r.bulkReads} bulk reads or exports within 15 minutes: a possible data exfiltration pattern.` });
    }
    if (input.risk === "destructive" && input.outcome !== "blocked" && crossing("delete", r.massDeletes, r.massDeleteWindowMs)) {
      out.push({ type: "mass_delete", severity: "critical", title: `${agentName} is deleting in bulk`, detail: `${r.massDeletes} deletes within 5 minutes.` });
    }
    return out;
  }

  /** True while the agent has a mass-delete signal (further deletes are blocked). */
  deletingInBulk(agentId: string): boolean {
    return this.count(agentId, "delete", THREAT_RULES.massDeleteWindowMs).length >= THREAT_RULES.massDeletes;
  }

  reset(agentId?: string): void {
    if (agentId) this.events.delete(agentId);
    else this.events.clear();
  }
}

/** What to change so it does not happen again, per trigger. */
export function incidentSuggestions(trigger: string, action?: string | null): string[] {
  const s: string[] = [];
  switch (trigger) {
    case "key_abuse":
      s.push("Revoke the key and issue a new one; keep agent keys in a secret manager.", "Set a short expiry on agent keys.");
      break;
    case "privilege_escalation":
      s.push("Reduce the agent's scopes to what it uses.", "Add a deny policy for the actions it tried.");
      break;
    case "rapid_enumeration":
    case "exfiltration":
      s.push("Limit the agent to the projects it needs.", "Set a per-minute rate limit on the agent.");
      break;
    case "mass_delete":
      s.push(`Add a policy: require approval for ${action ?? "deletes"}.`, "Set a per-minute rate limit on the agent.");
      break;
    case "repeated_blocks":
      s.push("Check what the agent is trying to do and fix its configuration, or revoke it.");
      break;
    case "critical_risk":
      s.push("Review the agent's risk factors and narrow its access before resuming it.");
      break;
    case "dlp":
      s.push("Turn on AI data masking.", "Keep secrets out of agent inputs; use a secret manager.");
      break;
    default:
      s.push("Review the agent's recent activity and narrow its access.");
  }
  s.push("Require a person to approve the agent's next action before it can act again.");
  return s;
}
