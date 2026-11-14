/**
 * Telemetry-driven automation: pure rules. Thresholds, settings and the
 * wording of the tasks the system opens. No database access here.
 */

export type AutomationRule =
  | "guide_dropoff"
  | "guide_completion_drop"
  | "survey_score"
  | "event_spike"
  | "sla_breaches"
  | "shadow_ai"
  | "compliance_gap"
  | "incident"
  | "key_expiry"
  | "vendor_review"
  | "project_governance";

export const AUTOMATION_RULES: Array<{
  id: AutomationRule;
  label: string;
  detail: string;
  group: "telemetry" | "governance";
}> = [
  {
    id: "guide_dropoff",
    group: "telemetry",
    label: "Guide step drop-off",
    detail:
      "A guide step loses more than the threshold of the people who reach it.",
  },
  {
    id: "guide_completion_drop",
    group: "telemetry",
    label: "Guide completion falls",
    detail:
      "A guide's completion rate drops by 30% or more against the week before.",
  },
  {
    id: "survey_score",
    group: "telemetry",
    label: "Survey score is low",
    detail: "A CSAT or rating survey averages below the threshold.",
  },
  {
    id: "event_spike",
    group: "telemetry",
    label: "Unusual event volume",
    detail: "An SDK integration sends 10× its usual daily events.",
  },
  {
    id: "sla_breaches",
    group: "telemetry",
    label: "SLA breaches rise",
    detail: "A project's SLA breaches at least double week on week.",
  },
  {
    id: "shadow_ai",
    group: "governance",
    label: "Unregistered agent found",
    detail:
      "A remediation task for its owner; closes when the agent gets a key or is blocked.",
  },
  {
    id: "compliance_gap",
    group: "governance",
    label: "Compliance control fails",
    detail: "One task per failing control; closes when the control passes.",
  },
  {
    id: "incident",
    group: "governance",
    label: "Incident opened",
    detail:
      "Investigate, contain, decide and document; closes when the incident is resolved.",
  },
  {
    id: "key_expiry",
    group: "governance",
    label: "Agent key expires soon",
    detail: "A rotation task for the owner; closes when the key is rotated.",
  },
  {
    id: "vendor_review",
    group: "governance",
    label: "New third party to review",
    detail:
      "A review task; closes when the vendor is approved, restricted or blocked.",
  },
  {
    id: "project_governance",
    group: "governance",
    label: "New project",
    detail:
      "A governance checklist; when done the project is marked Governance ready.",
  },
];

const RULE_IDS = AUTOMATION_RULES.map((r) => r.id);

export interface AutomationSettings {
  enabled: boolean;
  /** Project that receives tasks which do not belong to a specific project; null: the assignee's own list. */
  projectId: string | null;
  rules: Record<AutomationRule, boolean>;
  /** Share of people lost at a step (0-1) that opens a task. */
  dropOffThreshold: number;
  /** Fewest people who must reach a step before it is judged. */
  minSample: number;
  /** Average survey score (1-5 scale) under which a task opens. */
  surveyScoreThreshold: number;
  /** Days after a task is done before its metric is measured again. */
  remeasureDays: number;
  /** Days end-user events are kept; 0 keeps them indefinitely. */
  eventRetentionDays: number;
}

export const RETENTION_OPTIONS = [0, 30, 90, 180, 365] as const;

export const DEFAULT_AUTOMATION: AutomationSettings = {
  enabled: true,
  projectId: null,
  rules: Object.fromEntries(RULE_IDS.map((id) => [id, true])) as Record<
    AutomationRule,
    boolean
  >,
  dropOffThreshold: 0.4,
  minSample: 20,
  surveyScoreThreshold: 3.5,
  remeasureDays: 14,
  eventRetentionDays: 0,
};

const clamp = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function normalizeAutomation(raw: unknown): AutomationSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const rulesIn = (
    s.rules && typeof s.rules === "object" ? s.rules : {}
  ) as Record<string, unknown>;
  const retention = Number(s.eventRetentionDays);
  return {
    enabled:
      typeof s.enabled === "boolean" ? s.enabled : DEFAULT_AUTOMATION.enabled,
    projectId:
      typeof s.projectId === "string" && /^[a-f0-9]{24}$/i.test(s.projectId)
        ? s.projectId
        : null,
    rules: Object.fromEntries(
      RULE_IDS.map((id) => [
        id,
        typeof rulesIn[id] === "boolean" ? (rulesIn[id] as boolean) : true,
      ]),
    ) as Record<AutomationRule, boolean>,
    dropOffThreshold: clamp(
      s.dropOffThreshold,
      0.05,
      0.95,
      DEFAULT_AUTOMATION.dropOffThreshold,
    ),
    minSample: Math.round(
      clamp(s.minSample, 5, 10_000, DEFAULT_AUTOMATION.minSample),
    ),
    surveyScoreThreshold: clamp(
      s.surveyScoreThreshold,
      1,
      5,
      DEFAULT_AUTOMATION.surveyScoreThreshold,
    ),
    remeasureDays: Math.round(
      clamp(s.remeasureDays, 1, 90, DEFAULT_AUTOMATION.remeasureDays),
    ),
    eventRetentionDays: (RETENTION_OPTIONS as readonly number[]).includes(
      retention,
    )
      ? retention
      : 0,
  };
}

export const ruleOn = (
  settings: AutomationSettings,
  rule: AutomationRule,
): boolean => settings.enabled && settings.rules[rule];

/** What the system wants to exist: one open task per key while the condition holds. */
export interface Finding {
  rule: AutomationRule;
  /** Stable identity of the condition, e.g. "guide_dropoff:<guideId>:<stepId>". */
  key: string;
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** Who gets the task. */
  assigneeUserId: string;
  projectId?: string | null;
  /** Portal path that shows the telemetry or the thing to fix. */
  link: string;
  subtasks?: Array<{ title: string; done?: boolean }>;
  /** For metric rules: the number that should improve. */
  metric?: {
    name: string;
    unit: "percent" | "score" | "count";
    value: number;
    lowerIsBetter: boolean;
  };
  /** Ids needed to measure the metric again. */
  context?: Record<string, string>;
}

export const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function formatMetric(
  unit: "percent" | "score" | "count",
  value: number,
): string {
  if (unit === "percent") return pct(value);
  if (unit === "score") return value.toFixed(1);
  return String(Math.round(value));
}

/** The worst step of a funnel that crosses the threshold with enough people, if any. */
export function worstStep<
  T extends { reached: number; dropped: number; dropOffRate: number },
>(steps: T[], threshold: number, minSample: number): T | null {
  // The last step has no "next step": leaving there is finishing or dismissing, not drop-off between steps.
  const candidates = steps
    .slice(0, -1)
    .filter((s) => s.reached >= minSample && s.dropOffRate > threshold);
  if (!candidates.length) return null;
  return candidates.reduce((worst, s) =>
    s.dropOffRate > worst.dropOffRate ? s : worst,
  );
}

/** True when `current` fell by at least `by` (relative) against `previous`. */
export function droppedBy(
  previous: number,
  current: number,
  by: number,
): boolean {
  return previous > 0 && (previous - current) / previous >= by;
}

/** True when today's volume is at least `factor` times the usual daily volume. */
export function spiked(
  usualPerDay: number,
  today: number,
  factor: number,
  floor: number,
): boolean {
  return today >= floor && usualPerDay > 0 && today >= usualPerDay * factor;
}

/** Normalises a survey answer on any scale to 1-5, so one threshold fits CSAT, rating and opinion scales. */
export function toFivePoint(
  value: number,
  min: number,
  max: number,
): number | null {
  if (!Number.isFinite(value) || max <= min) return null;
  const clamped = Math.min(max, Math.max(min, value));
  return 1 + ((clamped - min) / (max - min)) * 4;
}

/** Whether a re-measured metric improved, got worse or stayed about the same (within 5% of the original). */
export function outcomeOf(
  before: number,
  after: number,
  lowerIsBetter: boolean,
): "improved" | "worse" | "unchanged" {
  const delta = after - before;
  if (Math.abs(delta) <= Math.abs(before) * 0.05) return "unchanged";
  return delta < 0 === lowerIsBetter ? "improved" : "worse";
}

export function describeTask(
  finding: Pick<Finding, "description" | "link">,
  baseUrl: string,
): string {
  return `${finding.description}\n\nOpened automatically by Pristine.\nOpen the source: ${baseUrl.replace(/\/$/, "")}${finding.link}`;
}

export const GOVERNANCE_CHECKLIST = [
  "Review the data label",
  "Confirm which agents can change this project",
  "Run a compliance check",
  "Assign a governance owner",
] as const;
export const INCIDENT_STEPS = [
  "Investigate what happened",
  "Contain the agent",
  "Decide: resume, re-approve or revoke",
  "Document the outcome",
] as const;
export const SHADOW_STEPS = [
  "Review what the tool is and who runs it",
  "Give it its own key, or block it",
  "Confirm the old login use has stopped",
] as const;
