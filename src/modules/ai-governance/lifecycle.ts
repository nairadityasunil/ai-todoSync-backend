import {
  requiredApprovals,
  riskLevel,
  riskScore,
  STAGES,
  type ApproverRole,
  type Gate,
  type Stage,
  type Tier,
} from "./catalog.js";
import {
  FACTSHEET_FIELDS,
  type Factsheet,
  type UseCaseApproval,
  type UseCaseRisk,
} from "./model.js";

/**
 * What a use case needs before it can move to the next stage, and how well it
 * is governed (a 0 to 100 score). Pure functions over a plain snapshot.
 */

export interface Snapshot {
  stage: Stage;
  status: "active" | "on_hold" | "rejected";
  tier: Tier | null;
  assessed: boolean;
  factsheet: Partial<Factsheet>;
  links: { agentIds: string[]; promptIds: string[]; vendorIds: string[] };
  risks: UseCaseRisk[];
  approvals: UseCaseApproval[];
  evaluation: {
    status: "pass" | "fail" | "no_data";
    ranAt: Date | string;
    records: number;
  } | null;
  openIssues: Array<{ severity: string }>;
  nextReviewAt: Date | string | null;
  highRiskExtraRoles?: ApproverRole[];
  now?: number;
}

export interface Requirement {
  id: string;
  label: string;
  met: boolean;
  /** Where in the portal to fix it. */
  section:
    | "assessment"
    | "factsheet"
    | "risks"
    | "evaluations"
    | "approvals"
    | "issues"
    | "review";
}

const filled = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

export const missingFactsheet = (
  factsheet: Partial<Factsheet>,
  requiredOnly = true,
): string[] =>
  FACTSHEET_FIELDS.filter(
    (f) => (!requiredOnly || f.required) && !filled(factsheet[f.key]),
  ).map((f) => f.label);

export const untreatedRisks = (risks: UseCaseRisk[]): UseCaseRisk[] =>
  risks.filter((r) => {
    if (r.status === "accepted" || r.status === "mitigated") return false;
    return true;
  });

/** Approvals still valid for a gate: the latest decision per role. */
export function gateSignoffs(
  approvals: UseCaseApproval[],
  gate: Gate,
): Map<ApproverRole, UseCaseApproval> {
  const latest = new Map<ApproverRole, UseCaseApproval>();
  for (const a of approvals)
    if (a.gate === gate && !a.void) latest.set(a.role, a);
  return latest;
}

export function pendingRoles(
  snapshot: Pick<Snapshot, "approvals" | "tier" | "highRiskExtraRoles">,
  gate: Gate,
): ApproverRole[] {
  const signed = gateSignoffs(snapshot.approvals, gate);
  return requiredApprovals(
    gate,
    snapshot.tier,
    snapshot.highRiskExtraRoles,
  ).filter((role) => signed.get(role)?.decision !== "approved");
}

export const nextStage = (stage: Stage): Stage | null => {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.indexOf("production") ? STAGES[i + 1] : null;
};

/** Everything that must be true to move from the current stage to the next one. */
export function requirementsFor(snapshot: Snapshot): Requirement[] {
  const target = nextStage(snapshot.stage);
  if (!target) return [];
  const out: Requirement[] = [];
  const tier = snapshot.tier;
  const governed = tier === "medium" || tier === "high";

  if (target === "assessment") {
    out.push({
      id: "described",
      label: "Describe the intended use",
      met: filled(snapshot.factsheet.intendedUse),
      section: "factsheet",
    });
  }
  if (target === "development") {
    out.push({
      id: "assessed",
      label: "Complete the risk and EU AI Act assessment",
      met: snapshot.assessed,
      section: "assessment",
    });
    out.push({
      id: "not_prohibited",
      label: "Not a prohibited practice",
      met: snapshot.assessed && tier !== "prohibited",
      section: "assessment",
    });
    const pending = snapshot.assessed
      ? pendingRoles(snapshot, "development")
      : [];
    out.push({
      id: "approved_development",
      label: "Approval to start development",
      met: snapshot.assessed && tier !== "prohibited" && pending.length === 0,
      section: "approvals",
    });
  }
  if (target === "validation") {
    const missing = missingFactsheet(snapshot.factsheet);
    out.push({
      id: "factsheet",
      label: missing.length
        ? `Complete the factsheet (${missing.join(", ")})`
        : "Complete the factsheet",
      met: missing.length === 0,
      section: "factsheet",
    });
    out.push({
      id: "risks_identified",
      label: governed
        ? "Identify at least one risk"
        : "Review the suggested risks",
      met: !governed || snapshot.risks.length > 0,
      section: "risks",
    });
    const linked =
      snapshot.links.agentIds.length +
        snapshot.links.promptIds.length +
        snapshot.links.vendorIds.length >
      0;
    out.push({
      id: "asset_linked",
      label: "Link the agent, prompt or vendor it runs on",
      met: !governed || linked,
      section: "factsheet",
    });
  }
  if (target === "production") {
    const untreated = untreatedRisks(snapshot.risks);
    out.push({
      id: "risks_treated",
      label: untreated.length
        ? `Treat every risk (${untreated.length} still open)`
        : "Treat every risk",
      met: untreated.length === 0,
      section: "risks",
    });
    const evalOk = snapshot.evaluation?.status === "pass";
    out.push({
      id: "evaluation_passed",
      label: governed
        ? "Pass an evaluation on logged interactions"
        : "Run an evaluation (optional for low risk)",
      met: !governed || evalOk,
      section: "evaluations",
    });
    const blocking = snapshot.openIssues.filter(
      (i) => i.severity === "high" || i.severity === "critical",
    ).length;
    out.push({
      id: "no_blocking_issues",
      label: blocking
        ? `Resolve high and critical issues (${blocking} open)`
        : "No high or critical issues open",
      met: blocking === 0,
      section: "issues",
    });
    out.push({
      id: "approved_production",
      label: "Approval to go to production",
      met: pendingRoles(snapshot, "production").length === 0,
      section: "approvals",
    });
  }
  if (snapshot.status !== "active") {
    out.unshift({
      id: "active",
      label:
        snapshot.status === "on_hold" ? "Take it off hold" : "It was rejected",
      met: false,
      section: "approvals",
    });
  }
  return out;
}

export interface ScorePart {
  id: "information" | "assets" | "evidence" | "controls";
  label: string;
  points: number;
  max: number;
  checks: Array<{ label: string; met: boolean }>;
}

const DAY = 86400000;

/**
 * Governance score: how completely a use case follows the governance policy.
 * Four parts of 25 points: information, assets, evidence and controls.
 */
export function governanceScore(snapshot: Snapshot): {
  score: number;
  parts: ScorePart[];
} {
  const now = snapshot.now ?? Date.now();
  const tier = snapshot.tier;
  const part = (
    id: ScorePart["id"],
    label: string,
    checks: Array<{ label: string; met: boolean }>,
  ): ScorePart => {
    const met = checks.filter((c) => c.met).length;
    return {
      id,
      label,
      checks,
      max: 25,
      points: checks.length ? Math.round((met / checks.length) * 25) : 0,
    };
  };
  const evalFresh =
    snapshot.evaluation != null &&
    now - new Date(snapshot.evaluation.ranAt).getTime() <= 8 * DAY;
  const reviewOverdue =
    snapshot.nextReviewAt != null &&
    new Date(snapshot.nextReviewAt).getTime() < now;
  const inOrPastProduction =
    snapshot.stage === "production" || snapshot.stage === "retired";
  const gate: Gate =
    inOrPastProduction || snapshot.stage === "validation"
      ? "production"
      : "development";
  const assessedNotProhibited = snapshot.assessed && tier !== "prohibited";

  const parts: ScorePart[] = [
    part("information", "Information", [
      { label: "Risk and EU AI Act assessment done", met: snapshot.assessed },
      {
        label: "Required factsheet fields filled",
        met: missingFactsheet(snapshot.factsheet).length === 0,
      },
      {
        label: "Whole factsheet filled",
        met: missingFactsheet(snapshot.factsheet, false).length === 0,
      },
    ]),
    part("assets", "Assets", [
      {
        label: "An agent, prompt or vendor is linked",
        met:
          snapshot.links.agentIds.length +
            snapshot.links.promptIds.length +
            snapshot.links.vendorIds.length >
          0,
      },
      {
        label: "Model and provider named",
        met:
          filled(snapshot.factsheet.modelName) &&
          filled(snapshot.factsheet.modelProvider),
      },
    ]),
    part("evidence", "Evidence", [
      {
        label: "Interactions are logged",
        met: (snapshot.evaluation?.records ?? 0) > 0,
      },
      { label: "Evaluated in the last week", met: evalFresh },
      {
        label: "Latest evaluation passed",
        met: snapshot.evaluation?.status === "pass",
      },
    ]),
    part("controls", "Controls", [
      { label: "Risks identified", met: snapshot.risks.length > 0 },
      {
        label: "Every risk treated",
        met:
          snapshot.risks.length > 0 &&
          untreatedRisks(snapshot.risks).length === 0,
      },
      {
        label: `Approved for ${gate}`,
        met: assessedNotProhibited && pendingRoles(snapshot, gate).length === 0,
      },
      {
        label: "No high or critical issues open",
        met: !snapshot.openIssues.some(
          (i) => i.severity === "high" || i.severity === "critical",
        ),
      },
      {
        label: "Periodic review up to date",
        met:
          !reviewOverdue &&
          (!inOrPastProduction || snapshot.nextReviewAt != null),
      },
    ]),
  ];
  return { score: parts.reduce((s, p) => s + p.points, 0), parts };
}

/** Counts for a 5×5 heatmap, keyed "likelihood:impact". Residual values where a risk was mitigated. */
export function heatmap(risks: UseCaseRisk[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of risks) {
    const l =
      r.status === "mitigated" && r.residualLikelihood
        ? r.residualLikelihood
        : r.likelihood;
    const i =
      r.status === "mitigated" && r.residualImpact
        ? r.residualImpact
        : r.impact;
    out[`${l}:${i}`] = (out[`${l}:${i}`] ?? 0) + 1;
  }
  return out;
}

export const currentRiskLevel = (r: UseCaseRisk) =>
  riskLevel(
    r.status === "mitigated" && r.residualLikelihood && r.residualImpact
      ? riskScore(r.residualLikelihood, r.residualImpact)
      : riskScore(r.likelihood, r.impact),
  );
