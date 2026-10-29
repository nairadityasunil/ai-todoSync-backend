import type { McpScope } from "../mcp/registry/tool-types.js";
import { isReviewDue } from "./hygiene.js";
import type { AgentKind, AgentRiskLevel, IAgentRiskFactor } from "./model.js";

/**
 * Deterministic agent risk scoring. Every factor carries the frameworks it
 * relates to; the mapping is guidance for reviews, not a certification.
 */

export const FRAMEWORKS = {
  OWASP_EXCESSIVE_AGENCY: "OWASP LLM06:2025 Excessive Agency",
  OWASP_SENSITIVE_DATA: "OWASP LLM02:2025 Sensitive Information Disclosure",
  OWASP_UNBOUNDED: "OWASP LLM10:2025 Unbounded Consumption",
  NIST_GOVERN: "NIST AI RMF: Govern",
  NIST_MANAGE: "NIST AI RMF: Manage",
  NIST_MEASURE: "NIST AI RMF: Measure",
  ISO_ACCESS: "ISO/IEC 42001: access control for AI systems",
  ISO_MONITORING: "ISO/IEC 42001: monitoring of AI systems",
  EU_LOGGING: "EU AI Act Art. 12: Record-keeping",
  EU_OVERSIGHT: "EU AI Act Art. 14: Human oversight",
  EU_SECURITY: "EU AI Act Art. 15: Accuracy, robustness and cybersecurity",
} as const;

export interface RiskInput {
  kind: AgentKind;
  scopes: McpScope[];
  projectIds: unknown[];
  legacy: boolean;
  expiresAt?: Date | null;
  createdAt?: Date | null;
  lastSeenAt?: Date | null;
  reviewedAt?: Date | null;
  ownerIsMember: boolean;
  openCriticalAlerts: number;
  openWarningAlerts: number;
  blockedLast7d: number;
  workspaceHasEnforcedPolicies: boolean;
  now?: Date;
}

export interface RiskResult {
  score: number;
  level: AgentRiskLevel;
  factors: IAgentRiskFactor[];
}

const DAY = 86400000;

export function levelForScore(score: number): AgentRiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

export function scoreAgent(input: RiskInput): RiskResult {
  const now = input.now ?? new Date();
  const factors: IAgentRiskFactor[] = [];
  const add = (
    code: string,
    label: string,
    weight: number,
    frameworks: string[],
  ) => factors.push({ code, label, weight, frameworks });

  if (input.kind === "ai_provider") {
    add(
      "external_model",
      "Sends project content to an external AI provider",
      10,
      [FRAMEWORKS.OWASP_SENSITIVE_DATA, FRAMEWORKS.EU_SECURITY],
    );
  }
  if (input.kind === "detected") {
    add(
      "unregistered",
      "Unregistered: runs with a person's login instead of its own key",
      30,
      [FRAMEWORKS.NIST_GOVERN, FRAMEWORKS.ISO_ACCESS, FRAMEWORKS.EU_LOGGING],
    );
  }
  if (input.scopes.includes("workspace:admin")) {
    add("admin_scope", "Can administer the workspace", 25, [
      FRAMEWORKS.OWASP_EXCESSIVE_AGENCY,
      FRAMEWORKS.NIST_GOVERN,
      FRAMEWORKS.ISO_ACCESS,
    ]);
  }
  if (
    input.scopes.some(
      (scope) => scope.endsWith(":write") || scope === "ai:execute",
    )
  ) {
    add("write_scope", "Can create, change or delete data", 15, [
      FRAMEWORKS.OWASP_EXCESSIVE_AGENCY,
      FRAMEWORKS.EU_OVERSIGHT,
    ]);
  }
  if (input.kind !== "ai_provider" && input.projectIds.length === 0) {
    add("all_projects", "Can reach every project its owner can", 10, [
      FRAMEWORKS.OWASP_EXCESSIVE_AGENCY,
      FRAMEWORKS.ISO_ACCESS,
    ]);
  }
  if (input.legacy) {
    add("legacy_key", "Legacy personal key with full access", 15, [
      FRAMEWORKS.ISO_ACCESS,
      FRAMEWORKS.NIST_MANAGE,
    ]);
  }
  if (input.kind === "api_key" && !input.expiresAt) {
    add("no_expiry", "Key never expires", 10, [FRAMEWORKS.ISO_ACCESS]);
  }
  if (!input.ownerIsMember) {
    add("orphaned", "Owner is no longer a workspace member", 25, [
      FRAMEWORKS.NIST_GOVERN,
      FRAMEWORKS.ISO_ACCESS,
    ]);
  }
  const lastActivity = input.lastSeenAt ?? null;
  if (
    (lastActivity && now.getTime() - lastActivity.getTime() > 30 * DAY) ||
    (!lastActivity &&
      input.createdAt &&
      now.getTime() - input.createdAt.getTime() > 14 * DAY)
  ) {
    add("stale", "Unused for 30 days or never used", 5, [
      FRAMEWORKS.NIST_MANAGE,
    ]);
  }
  if (
    isReviewDue(
      {
        kind: input.kind,
        status: "active",
        createdAt: input.createdAt,
        reviewedAt: input.reviewedAt,
      },
      now,
    )
  ) {
    add("review_overdue", "Access not confirmed in the last 90 days", 5, [
      FRAMEWORKS.ISO_ACCESS,
      FRAMEWORKS.NIST_GOVERN,
    ]);
  }
  if (input.openCriticalAlerts > 0) {
    add(
      "critical_alerts",
      `${input.openCriticalAlerts} open critical alert(s)`,
      20,
      [FRAMEWORKS.NIST_MEASURE, FRAMEWORKS.ISO_MONITORING],
    );
  } else if (input.openWarningAlerts > 0) {
    add("warning_alerts", `${input.openWarningAlerts} open warning(s)`, 10, [
      FRAMEWORKS.NIST_MEASURE,
      FRAMEWORKS.ISO_MONITORING,
    ]);
  }
  if (input.blockedLast7d >= 5) {
    add(
      "frequent_blocks",
      `${input.blockedLast7d} blocked actions in 7 days`,
      5,
      [FRAMEWORKS.OWASP_UNBOUNDED, FRAMEWORKS.NIST_MEASURE],
    );
  }
  if (!input.workspaceHasEnforcedPolicies) {
    add("no_oversight", "No enforced agent policies in the workspace", 10, [
      FRAMEWORKS.EU_OVERSIGHT,
      FRAMEWORKS.NIST_GOVERN,
    ]);
  }

  const score = Math.min(
    100,
    factors.reduce((sum, factor) => sum + factor.weight, 0),
  );
  return { score, level: levelForScore(score), factors };
}
