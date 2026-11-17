import type { ToolKind } from "./catalog.js";

/**
 * How risky one AI tool is for this workspace, 0 to 100, with the reasons.
 * Pure. The score ranks the review queue; it does not replace the review.
 */

export type ToolStatus =
  | "unreviewed"
  | "sanctioned"
  | "restricted"
  | "prohibited"
  | "dismissed";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskInput {
  kind: ToolKind;
  status: ToolStatus;
  users: number;
  bytesOut: number;
  uploads: number;
  /** Share of seen requests made with a personal (non-company) account, 0 to 1. */
  personalShare: number;
  hasSecret: boolean;
  hasBroadGrant: boolean;
  sources: number;
  /** A third-party review of the vendor exists and was approved. */
  vendorApproved: boolean;
  /** Used in the last 14 days. */
  recentlyUsed: boolean;
}

export interface RiskFactor {
  label: string;
  points: number;
}

const KIND_BASE: Record<ToolKind, [number, string]> = {
  model_api: [30, "Sends data to a model through an API"],
  coding: [30, "Sees source code and secrets"],
  meeting: [30, "Records and transcribes meetings"],
  agent_platform: [35, "Acts on its own with tools and credentials"],
  assistant: [25, "General chat assistant: anything can be pasted in"],
  unknown: [25, "Not yet classified"],
  writing: [20, "Receives drafts and documents"],
  model_hub: [20, "Hosts models and data outside the company"],
  image_video: [15, "Generates media from prompts and uploads"],
  search: [15, "Search with queries that can reveal plans"],
  local_runtime: [10, "Runs on the device, but pulls models from outside"],
};

export function assessRisk(i: RiskInput): {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
} {
  const factors: RiskFactor[] = [];
  const add = (label: string, points: number) =>
    points !== 0 && factors.push({ label, points });
  const [base, why] = KIND_BASE[i.kind];
  add(why, base);
  add(
    `${i.users} ${i.users === 1 ? "person uses" : "people use"} it`,
    Math.min(20, i.users > 0 ? Math.ceil(Math.log2(i.users + 1) * 4) : 0),
  );
  if (i.bytesOut >= 10 * 1024 * 1024) add("Sent more than 10 MB out", 10);
  else if (i.bytesOut >= 1024 * 1024) add("Sent more than 1 MB out", 5);
  if (i.uploads > 0) add("Files were uploaded", 10);
  if (i.personalShare > 0.5) add("Mostly used through personal accounts", 10);
  if (i.hasSecret) add("A key for it was found in code", 25);
  if (i.hasBroadGrant)
    add("Connected to company data (mail, files or calendar)", 15);
  if (i.sources >= 2) add("Seen through more than one source", 5);
  if (i.vendorApproved) add("Vendor review approved", -10);
  if (i.status === "sanctioned") add("Sanctioned by an admin", -35);
  else if (i.status === "restricted") add("Allowed with conditions", -15);
  else if (i.status === "prohibited" && i.recentlyUsed)
    add("Prohibited but still in use", 15);
  const score = Math.max(
    0,
    Math.min(
      100,
      factors.reduce((s, f) => s + f.points, 0),
    ),
  );
  const level: RiskLevel =
    score >= 70
      ? "critical"
      : score >= 50
        ? "high"
        : score >= 30
          ? "medium"
          : "low";
  return { score, level, factors };
}
