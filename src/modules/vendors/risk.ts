import type { Answers } from "./questionnaire.js";

/**
 * Third-party risk: inherent risk from what the vendor can reach and how
 * critical it is, residual risk after the controls the assessment and
 * evidence show. Deterministic and pure; every factor names its framework.
 * The mapping supports reviews; it is not a certification.
 */

export type VendorTier = 1 | 2 | 3;
export type VendorRiskLevel = "low" | "medium" | "high" | "critical";

export interface VendorRiskFactor {
  code: string;
  label: string;
  /** Positive adds risk; negative is a control that removes it. */
  weight: number;
  framework: string;
}

export interface VendorRiskInput {
  category: string;
  tier: VendorTier;
  /** Scopes of the agents linked to it (all kinds). */
  scopes: string[];
  /** Whether it receives prompts or project content (AI providers). */
  receivesContent: boolean;
  /** Any linked agent may reach every project. */
  allProjects: boolean;
  answers: Answers;
  assessmentCompletedAt?: Date | null;
  nextReviewAt?: Date | null;
  /** Kinds of unexpired evidence on file. */
  evidence: string[];
  dpaExpiresAt?: Date | null;
  workspaceMasksAiData: boolean;
  now?: Date;
}

export interface VendorRiskResult {
  inherent: number;
  residual: number;
  level: VendorRiskLevel;
  factors: VendorRiskFactor[];
}

const DAY = 86400000;

/** Months between reassessments, by tier (1 = most critical). */
export const REVIEW_CADENCE_MONTHS: Record<VendorTier, number> = {
  1: 12,
  2: 24,
  3: 36,
};

export function nextReviewDate(tier: VendorTier, from: Date): Date {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + REVIEW_CADENCE_MONTHS[tier]);
  return next;
}

export function levelFor(score: number): VendorRiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

const FW = {
  SUPPLIER: "ISO/IEC 27001 A.5.19-A.5.22",
  SUPPLY_CHAIN: "NIST CSF 2.0 GV.SC",
  PROCESSOR: "GDPR Art. 28",
  DEPLOYER: "EU AI Act Art. 26",
  ICT: "DORA Art. 28",
};

export function scoreVendor(input: VendorRiskInput): VendorRiskResult {
  const now = input.now ?? new Date();
  const factors: VendorRiskFactor[] = [];
  const add = (
    code: string,
    label: string,
    weight: number,
    framework: string,
  ) => factors.push({ code, label, weight, framework });

  // Inherent risk.
  if (input.receivesContent) {
    add(
      "receives_content",
      "Receives prompts and project content",
      30,
      FW.PROCESSOR,
    );
  }
  if (input.scopes.includes("workspace:admin")) {
    add("admin_access", "Can administer the workspace", 25, FW.SUPPLIER);
  } else if (
    input.scopes.some((s) => s.endsWith(":write") || s === "ai:execute")
  ) {
    add("write_access", "Can change data", 15, FW.SUPPLIER);
  } else if (input.scopes.length > 0) {
    add("read_access", "Can read data", 5, FW.SUPPLIER);
  }
  if (input.allProjects) {
    add("all_projects", "Reaches every project of its users", 10, FW.SUPPLIER);
  }
  if (input.tier === 1)
    add("tier_1", "Critical to operations (tier 1)", 20, FW.ICT);
  else if (input.tier === 2)
    add("tier_2", "Important to operations (tier 2)", 10, FW.ICT);
  if (input.category === "ai_model" || input.category === "ai_assistant") {
    add("ai_system", "AI system acting on workspace data", 5, FW.DEPLOYER);
  }
  const inherent = Math.min(
    100,
    factors.reduce((sum, f) => sum + f.weight, 0),
  );

  // Controls (only once an assessment exists) and gaps.
  const a = input.answers;
  const assessed = Boolean(input.assessmentCompletedAt);
  if (!assessed) {
    add(
      "not_assessed",
      "No completed due-diligence assessment",
      10,
      FW.SUPPLY_CHAIN,
    );
  } else {
    if (a.trains_on_data === "no" || a.trains_on_data === "opt_out")
      add("no_training", "Does not train on workspace data", -15, FW.DEPLOYER);
    else if (a.trains_on_data === "yes")
      add("trains_on_data", "Trains on workspace data", 15, FW.DEPLOYER);
    if (a.retention === "zero")
      add("zero_retention", "Keeps no data", -10, FW.PROCESSOR);
    else if (a.retention === "30_days")
      add("short_retention", "Keeps data 30 days or less", -5, FW.PROCESSOR);
    if (a.incident_notice === "72h")
      add("incident_notice", "Notifies incidents within 72 hours", -5, FW.ICT);
    if (a.encryption === "yes")
      add(
        "encryption",
        "Encrypts data in transit and at rest",
        -5,
        FW.SUPPLIER,
      );
    if (input.nextReviewAt && input.nextReviewAt.getTime() < now.getTime()) {
      add("review_overdue", "Reassessment overdue", 10, FW.SUPPLY_CHAIN);
    }
  }
  const hasCert = input.evidence.some((kind) =>
    ["soc2", "iso27001", "iso42001"].includes(kind),
  );
  if (hasCert)
    add(
      "certified",
      "Current SOC 2 or ISO certification on file",
      -15,
      FW.SUPPLIER,
    );
  const dpaCurrent =
    assessed &&
    a.dpa_signed === "yes" &&
    (!input.dpaExpiresAt || input.dpaExpiresAt.getTime() > now.getTime());
  if (dpaCurrent)
    add("dpa", "Data processing agreement in force", -15, FW.PROCESSOR);
  else if (input.receivesContent)
    add("no_dpa", "No data processing agreement in force", 10, FW.PROCESSOR);
  if (input.receivesContent && input.workspaceMasksAiData) {
    add("masking", "Personal data masked before it is sent", -10, FW.PROCESSOR);
  }

  const residual = Math.max(
    0,
    Math.min(
      100,
      factors.reduce((sum, f) => sum + f.weight, 0),
    ),
  );
  return { inherent, residual, level: levelFor(residual), factors };
}

/** Evidence or contract dates in the next `days` (for reminders). */
export const expiresWithin = (
  date: Date | null | undefined,
  days: number,
  now = new Date(),
) =>
  Boolean(
    date &&
    date.getTime() > now.getTime() &&
    date.getTime() - now.getTime() <= days * DAY,
  );
