import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import EmailService from "../../shared/services/email.service.js";
import { toCsv } from "../../utils/csv.js";
import { createZip } from "../../utils/zip.js";
import UserModel from "../auth/models/user.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { raiseAlert } from "./activity.service.js";
import { complianceReport } from "./governance.service.js";
import { normalizeGovernance } from "./hybrid.js";
import { logGovernanceEvent } from "./hybrid.service.js";
import {
  AgentActivityModel,
  AgentAlertModel,
  AgentApprovalModel,
  AgentIncidentModel,
  AgentModel,
  AgentPolicyModel,
  ComplianceSnapshotModel,
  GovernanceEventModel,
} from "./model.js";
import webhookService from "./webhooks.service.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";

type Report = Awaited<ReturnType<typeof complianceReport>>;

import { driftedControls } from "./compliance-drift.js";

export { driftedControls };

/**
 * Runs the compliance checks, stores a snapshot for the trend, and raises a
 * drift alert for each control that has started failing.
 */
export async function snapshotCompliance(workspaceId: string, reason: string, userId?: string | null): Promise<{ report: Report; drifted: Array<{ id: string; title: string; status: string }> }> {
  const report = await complianceReport(workspaceId);
  const ws = new Types.ObjectId(workspaceId);
  const previous = await ComplianceSnapshotModel.findOne({ workspaceId: ws }).sort({ createdAt: -1 }).lean();
  const controls = report.controls.map((c) => ({ id: c.id, title: c.title, status: c.status }));
  const drifted = previous ? driftedControls(previous.controls, controls) : [];
  await ComplianceSnapshotModel.create({ workspaceId: ws, score: report.score, controls });
  await logGovernanceEvent({
    workspaceId,
    type: "compliance_check",
    actor: userId ? "person" : "system",
    userId: userId ?? null,
    title: `Compliance check (${reason}): score ${report.score}`,
    detail: `${controls.filter((c) => c.status === "met").length} of ${controls.length} controls met.`,
  });
  for (const control of drifted) {
    await raiseAlert({
      workspaceId,
      agentId: null,
      type: "compliance_drift",
      severity: "warning",
      title: `Compliance control started failing: ${control.title}`,
      detail: `Was met, now ${control.status}. Score ${previous?.score ?? "?"} → ${report.score}.`,
      dedupeKey: `compliance_drift:${workspaceId}:${control.id}:${new Date().toISOString().slice(0, 10)}`,
    }).catch(() => undefined);
    webhookService.emit({
      type: "compliance.drift",
      workspaceId,
      severity: "warning",
      summary: `Compliance drift: "${control.title}" is now ${control.status}`,
      data: { control: control.id, status: control.status, score: report.score, previousScore: previous?.score ?? null },
    });
  }
  return { report, drifted };
}

/** Score history for the dashboard trend (one point per day, latest of the day). */
export async function complianceTrend(workspaceId: string, days = 90) {
  const rows = await ComplianceSnapshotModel.find({
    workspaceId: new Types.ObjectId(workspaceId),
    createdAt: { $gte: new Date(Date.now() - days * 86_400_000) },
  })
    .sort({ createdAt: 1 })
    .select("score createdAt")
    .lean();
  const byDay = new Map<string, { date: string; score: number }>();
  for (const row of rows) {
    const date = new Date(row.createdAt).toISOString().slice(0, 10);
    byDay.set(date, { date, score: row.score });
  }
  return [...byDay.values()];
}

const checks = new Map<string, ReturnType<typeof setTimeout>>();
/** Re-checks compliance shortly after a key event (policy change, new agent, incident); debounced. */
export function scheduleComplianceCheck(workspaceId: string | null | undefined, reason: string): void {
  if (!workspaceId) return;
  const existing = checks.get(workspaceId);
  if (existing) clearTimeout(existing);
  checks.set(
    workspaceId,
    setTimeout(() => {
      checks.delete(workspaceId);
      void snapshotCompliance(workspaceId, reason).catch((error) =>
        logger.warn("Compliance check failed", { message: error instanceof Error ? error.message : String(error) }),
      );
    }, 30_000).unref(),
  );
}

/** Evidence pack (ZIP) for auditors: inventory, policies, approvals, shadow AI, DLP and threats, incidents, activity summary, controls. */
export async function buildEvidencePack(workspaceId: string, range: { from: Date; to: Date }, userId?: string | null): Promise<{ filename: string; zip: Buffer; report: Report }> {
  const ws = new Types.ObjectId(workspaceId);
  const window = { $gte: range.from, $lte: range.to };
  const [report, workspace, agents, policies, approvals, alerts, incidents, activity, events, trend] = await Promise.all([
    complianceReport(workspaceId),
    WorkspaceModel.findById(ws).select("name settings").lean(),
    AgentModel.find({ workspaceId: ws }).select("name kind status riskLevel riskScore scopes projectIds expiresAt keyIssuedAt lastSeenAt ownerUserId detectionSignals replacedByAgentId createdAt").lean(),
    AgentPolicyModel.find({ workspaceId: ws }).lean(),
    AgentApprovalModel.find({ workspaceId: ws, createdAt: window }).select("-input -replayTokenHash -result").sort({ createdAt: 1 }).lean(),
    AgentAlertModel.find({ workspaceId: ws, createdAt: window }).sort({ createdAt: 1 }).lean(),
    AgentIncidentModel.find({ workspaceId: ws, createdAt: window }).sort({ createdAt: 1 }).lean(),
    AgentActivityModel.aggregate<{ _id: { agentId: Types.ObjectId; outcome: string; decidedBy: string | null }; n: number }>([
      { $match: { workspaceId: ws, createdAt: window } },
      { $group: { _id: { agentId: "$agentId", outcome: "$outcome", decidedBy: "$decidedBy" }, n: { $sum: 1 } } },
    ]),
    GovernanceEventModel.find({ workspaceId: ws, createdAt: window }).sort({ createdAt: 1 }).lean(),
    complianceTrend(workspaceId, 365),
  ]);
  const agentName = new Map(agents.map((a) => [String(a._id), a.name]));
  const governance = normalizeGovernance((workspace?.settings as { governance?: unknown } | undefined)?.governance);
  const d = (v: unknown) => (v ? new Date(v as string).toISOString() : "");
  const period = `${range.from.toISOString().slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}`;
  const shadow = agents.filter((a) => a.kind === "detected");
  const files = [
    {
      name: "README.txt",
      content: [
        `Compliance evidence pack: ${workspace?.name ?? workspaceId}`,
        `Period: ${period}`,
        `Generated: ${new Date().toISOString()}`,
        `Compliance score: ${report.score}/100`,
        "",
        "Files:",
        "  controls.csv           Each control, its framework mapping, status and evidence",
        "  score-trend.csv        Compliance score over time",
        "  agents.csv             Agent inventory with risk scores",
        "  policies.json          Policies and their modes, plus the governance settings",
        "  approvals.csv          Approval history (requests and decisions)",
        "  shadow-ai.csv          Unregistered agents found and how they were remediated",
        "  dlp-and-threats.csv    Data loss prevention and threat events",
        "  incidents.json         Incidents with their timelines",
        "  activity-summary.csv   Agent actions by outcome and decision source",
        "  governance-events.csv  Automatic (system) and manual governance actions",
        "",
        report.disclaimer,
      ].join("\n"),
    },
    {
      name: "controls.csv",
      content: toCsv(["id", "framework", "title", "status", "evidence", "recommendation"], report.controls.map((c) => [c.id, c.framework, c.title, c.status, c.evidence, c.recommendation ?? ""])),
    },
    { name: "score-trend.csv", content: toCsv(["date", "score"], trend.map((t) => [t.date, t.score])) },
    {
      name: "agents.csv",
      content: toCsv(
        ["id", "name", "kind", "status", "risk_level", "risk_score", "scopes", "projects", "key_issued", "expires", "last_seen", "created"],
        agents.map((a) => [String(a._id), a.name, a.kind, a.status, a.riskLevel, a.riskScore, a.scopes.join(" "), a.projectIds.length || "all", d(a.keyIssuedAt), d(a.expiresAt), d(a.lastSeenAt), d((a as unknown as { createdAt?: Date }).createdAt)]),
      ),
    },
    { name: "policies.json", content: JSON.stringify({ governance, policies }, null, 2) },
    {
      name: "approvals.csv",
      content: toCsv(
        ["requested", "agent", "action", "risk", "tier", "policy", "recommendation", "status", "decided", "decided_by_system"],
        approvals.map((a) => [d((a as unknown as { createdAt: Date }).createdAt), agentName.get(String(a.agentId)) ?? String(a.agentId), a.action, a.risk, a.tier ?? "", a.policyName ?? "", a.recommendation?.decision ?? "", a.status, d(a.decidedAt), a.decidedBySystem ? "yes" : "no"]),
      ),
    },
    {
      name: "shadow-ai.csv",
      content: toCsv(
        ["agent", "status", "signals", "found", "replaced_by_key"],
        shadow.map((a) => [a.name, a.status, (a.detectionSignals ?? []).join(" "), d((a as unknown as { createdAt?: Date }).createdAt), a.replacedByAgentId ? agentName.get(String(a.replacedByAgentId)) ?? "yes" : ""]),
      ),
    },
    {
      name: "dlp-and-threats.csv",
      content: toCsv(
        ["at", "type", "severity", "agent", "title", "detail", "acknowledged"],
        alerts.filter((a) => ["dlp", "threat", "unregistered_agent", "compliance_drift", "critical_risk"].includes(a.type)).map((a) => [d(a.createdAt), a.type, a.severity, a.agentId ? agentName.get(String(a.agentId)) ?? "" : "", a.title, a.detail, d(a.acknowledgedAt)]),
      ),
    },
    { name: "incidents.json", content: JSON.stringify(incidents, null, 2) },
    {
      name: "activity-summary.csv",
      content: toCsv(["agent", "outcome", "decided_by", "count"], activity.map((r) => [agentName.get(String(r._id.agentId)) ?? String(r._id.agentId), r._id.outcome, r._id.decidedBy ?? "", r.n])),
    },
    {
      name: "governance-events.csv",
      content: toCsv(["at", "actor", "type", "title", "detail"], events.map((e) => [d(e.createdAt), e.actor, e.type, e.title, e.detail])),
    },
  ];
  await logGovernanceEvent({
    workspaceId,
    type: "evidence_pack",
    actor: userId ? "person" : "system",
    userId: userId ?? null,
    title: `Compliance evidence pack generated (${period})`,
    detail: `Score ${report.score}. ${agents.length} agents, ${approvals.length} approvals, ${incidents.length} incidents.`,
  });
  return { filename: `compliance-evidence-${range.to.toISOString().slice(0, 10)}.zip`, zip: createZip(files), report };
}

/** Weekly or monthly reports: a fresh check, a webhook with the summary, and an email to admins. */
export async function runScheduledReports(now = new Date()): Promise<number> {
  const workspaces = await WorkspaceModel.find({ "settings.governance.complianceReportSchedule": { $in: ["weekly", "monthly"] } })
    .select("name settings")
    .lean();
  let sent = 0;
  for (const workspace of workspaces) {
    const schedule = normalizeGovernance((workspace.settings as { governance?: unknown } | undefined)?.governance).complianceReportSchedule;
    const since =
      schedule === "weekly"
        ? new Date(now.getTime() - 7 * 86_400_000)
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const already = await GovernanceEventModel.exists({ workspaceId: workspace._id, type: "scheduled_report", createdAt: { $gte: since } });
    if (already) continue;
    const workspaceId = workspace._id.toString();
    try {
      const { report, drifted } = await snapshotCompliance(workspaceId, `${schedule} report`);
      const failing = report.controls.filter((c) => c.status !== "met");
      const summary = `${schedule === "weekly" ? "Weekly" : "Monthly"} compliance report for ${workspace.name}: score ${report.score}/100, ${failing.length} control(s) need attention.`;
      webhookService.emit({
        type: "compliance.report",
        workspaceId,
        severity: failing.length ? "warning" : "info",
        summary,
        data: { score: report.score, failing: failing.map((c) => ({ id: c.id, title: c.title, status: c.status })), drifted },
      });
      const admins = await WorkspaceMemberModel.find({ workspaceId: workspace._id, role: { $in: ["OWNER", "ADMIN"] } }).select("userId").lean();
      const users = await UserModel.find({ _id: { $in: admins.map((a) => a.userId) } }).select("email").lean();
      const text = [summary, "", ...failing.map((c) => `- ${c.title}: ${c.status}. ${c.recommendation ?? ""}`), "", "Download the full evidence pack under Agent Governance → Settings → Compliance."].join("\n");
      await Promise.all(users.map((u) => EmailService.sendEmail(u.email, `Pristine ${schedule} compliance report: ${report.score}/100`, text).catch(() => false)));
      await logGovernanceEvent({ workspaceId, type: "scheduled_report", actor: "system", title: summary, detail: `Sent to ${users.length} admin(s) and the workspace's webhooks.` });
      sent += 1;
    } catch (error) {
      logger.warn("Scheduled compliance report failed", { workspaceId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return sent;
}

/** Daily: a snapshot for every workspace that has agents (drift alerts come from comparing snapshots). */
export async function monitorCompliance(): Promise<number> {
  const ids = await AgentModel.distinct("workspaceId", { workspaceId: { $ne: null } });
  let checked = 0;
  for (const id of ids) {
    try {
      await snapshotCompliance(String(id), "daily monitoring");
      checked += 1;
    } catch (error) {
      logger.warn("Compliance monitoring failed", { workspaceId: String(id), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return checked;
}

/**
 * Drift detection for cost: an agent whose AI spend in the last 24 hours is at
 * least three times its daily average over the previous week (and at least $1).
 * Raises an alert and refreshes the agent's risk score.
 */
export async function detectCostDrift(now = new Date()): Promise<number> {
  const day = new Date(now.getTime() - 86_400_000);
  const week = new Date(now.getTime() - 8 * 86_400_000);
  const logs = await PromptExecutionLogModel.find({ createdAt: { $gte: week }, agentId: { $ne: null }, status: "success" })
    .select("agentId totalCost createdAt")
    .limit(200_000)
    .lean()
    .catch(() => []);
  const byAgent = new Map<string, { recent: number; before: number }>();
  for (const log of logs) {
    const key = String(log.agentId);
    const entry = byAgent.get(key) ?? { recent: 0, before: 0 };
    if (new Date(log.createdAt as unknown as Date) >= day) entry.recent += Number(log.totalCost) || 0;
    else entry.before += Number(log.totalCost) || 0;
    byAgent.set(key, entry);
  }
  let raised = 0;
  for (const [agentId, spend] of byAgent) {
    const average = spend.before / 7;
    if (spend.recent < 1 || spend.recent < 3 * Math.max(average, 0.01)) continue;
    const agent = await AgentModel.findById(agentId);
    if (!agent) continue;
    await raiseAlert({
      workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
      agentId,
      type: "volume_spike",
      severity: "warning",
      title: `${agent.name}'s AI cost jumped`,
      detail: `$${spend.recent.toFixed(2)} in the last 24 hours against about $${average.toFixed(2)} a day the week before.`,
      dedupeKey: `cost_drift:${agentId}:${now.toISOString().slice(0, 10)}`,
    }).catch(() => undefined);
    const { recomputeRisk } = await import("./governance.service.js");
    await recomputeRisk(agent).catch(() => undefined);
    raised += 1;
  }
  return raised;
}
