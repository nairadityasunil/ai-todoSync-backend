import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { raiseAlert } from "./activity.service.js";
import {
  AGENT_ACTIVITY_RETENTION_DAYS,
  AgentActivityModel,
  AgentAlertModel,
  AgentApprovalModel,
  AgentModel,
  AgentPolicyModel,
  type IAgentDocument,
} from "./model.js";
import { unusualHours } from "./alert-rules.js";
import { FRAMEWORKS, scoreAgent } from "./risk.js";

const DAY = 86400000;
const WINDOW_MS = 15 * 60 * 1000;

const oid = (id: string | Types.ObjectId) => new Types.ObjectId(id.toString());

/* ------------------------------------------------------------------ */
/* Risk                                                                */
/* ------------------------------------------------------------------ */

export async function recomputeRisk(
  agent: IAgentDocument,
): Promise<IAgentDocument> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [ownerMembership, criticalAlerts, warningAlerts, blocked, enforced] =
    await Promise.all([
      agent.workspaceId
        ? WorkspaceMemberModel.exists({
            workspaceId: agent.workspaceId,
            userId: agent.ownerUserId,
          })
        : Promise.resolve(true),
      AgentAlertModel.countDocuments({
        agentId: agent._id,
        acknowledgedAt: null,
        severity: "critical",
      }),
      AgentAlertModel.countDocuments({
        agentId: agent._id,
        acknowledgedAt: null,
        severity: "warning",
      }),
      AgentActivityModel.countDocuments({
        agentId: agent._id,
        outcome: "blocked",
        createdAt: { $gte: weekAgo },
      }),
      agent.workspaceId
        ? AgentPolicyModel.exists({
            workspaceId: agent.workspaceId,
            enabled: true,
            mode: "enforce",
            effect: { $in: ["deny", "require_approval"] },
          })
        : Promise.resolve(null),
    ]);
  const result = scoreAgent({
    kind: agent.kind,
    scopes: agent.scopes,
    projectIds: agent.projectIds ?? [],
    legacy: agent.legacy,
    expiresAt: agent.expiresAt,
    createdAt: agent.createdAt,
    lastSeenAt: agent.lastSeenAt,
    ownerIsMember: Boolean(ownerMembership),
    openCriticalAlerts: criticalAlerts,
    openWarningAlerts: warningAlerts,
    blockedLast7d: blocked,
    workspaceHasEnforcedPolicies: Boolean(enforced),
    now,
  });
  await AgentModel.updateOne(
    { _id: agent._id },
    {
      $set: {
        riskScore: result.score,
        riskLevel: result.level,
        riskFactors: result.factors,
        riskEvaluatedAt: now,
      },
    },
  );
  agent.riskScore = result.score;
  agent.riskLevel = result.level;
  agent.riskFactors = result.factors;
  agent.riskEvaluatedAt = now;
  return agent;
}

export async function recomputeAllRisk(): Promise<number> {
  let count = 0;
  const cursor = AgentModel.find({ status: { $ne: "revoked" } }).cursor();
  for await (const agent of cursor) {
    try {
      await recomputeRisk(agent);
      count += 1;
      const lastActive = agent.lastSeenAt ?? agent.createdAt;
      if (
        agent.status === "active" &&
        lastActive &&
        Date.now() - lastActive.getTime() > 30 * DAY
      ) {
        await raiseAlert({
          workspaceId: agent.workspaceId?.toString() ?? null,
          agentId: agent._id.toString(),
          type: "stale_agent",
          severity: "info",
          title: `${agent.name} has not been used for 30 days`,
          detail:
            "Unused credentials are a common way in. Revoke it if it is no longer needed.",
          dedupeKey: `stale_agent:${agent._id}:${Math.floor(Date.now() / (30 * DAY))}`,
        });
      }
    } catch (error) {
      logger.warn("Agent risk recompute failed", {
        agentId: agent._id.toString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Behavioural alerts                                                  */
/* ------------------------------------------------------------------ */

export const ALERT_THRESHOLDS = {
  bulkDestructive: 10,
  permissionErrors: 5,
  volumeMinimum: 60,
  volumeMultiplier: 5,
};

/** Looks at the last 15 minutes of agent activity and raises alerts. */
export async function detectAlerts(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const bucket = Math.floor(now.getTime() / WINDOW_MS);
  // Plain $match + $group stages only, so this also runs on Mongo-compatible stores.
  const window = { createdAt: { $gte: since, $lte: now } };
  const countBy = (match: Record<string, unknown>) =>
    AgentActivityModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { ...window, ...match } },
      { $group: { _id: "$agentId", n: { $sum: 1 } } },
    ]);
  const [totals, destructive, denied, actionRows] = await Promise.all([
    AgentActivityModel.aggregate<{
      _id: { agentId: Types.ObjectId; workspaceId: Types.ObjectId | null };
      total: number;
    }>([
      { $match: window },
      {
        $group: {
          _id: { agentId: "$agentId", workspaceId: "$workspaceId" },
          total: { $sum: 1 },
        },
      },
    ]),
    countBy({
      risk: { $in: ["destructive", "security_critical"] },
      outcome: "allowed",
    }),
    countBy({
      $or: [{ outcome: "blocked" }, { statusCode: { $in: [401, 403] } }],
    }),
    AgentActivityModel.aggregate<{
      _id: { agentId: Types.ObjectId; action: string };
    }>([
      { $match: window },
      { $group: { _id: { agentId: "$agentId", action: "$action" } } },
    ]),
  ]);
  const byAgent = (rows: Array<{ _id: Types.ObjectId; n: number }>) =>
    new Map(rows.map((row) => [row._id.toString(), row.n]));
  const destructiveBy = byAgent(destructive);
  const deniedBy = byAgent(denied);
  const actionsBy = new Map<string, string[]>();
  for (const row of actionRows) {
    const id = row._id.agentId.toString();
    actionsBy.set(id, [...(actionsBy.get(id) ?? []), row._id.action]);
  }
  const rows = totals.map((row) => {
    const id = row._id.agentId.toString();
    return {
      _id: row._id.agentId,
      workspaceId: row._id.workspaceId,
      total: row.total,
      destructive: destructiveBy.get(id) ?? 0,
      denied: deniedBy.get(id) ?? 0,
      actions: actionsBy.get(id) ?? [],
    };
  });

  let raised = 0;
  for (const row of rows) {
    const agentId = row._id.toString();
    const agent = await AgentModel.findById(agentId)
      .select("name workspaceId")
      .lean();
    if (!agent) continue;
    const base = { workspaceId: row.workspaceId?.toString() ?? null, agentId };

    if (row.destructive >= ALERT_THRESHOLDS.bulkDestructive) {
      raised += Number(
        await raiseAlert({
          ...base,
          type: "bulk_destructive",
          severity: "critical",
          title: `${agent.name} made ${row.destructive} destructive changes in 15 minutes`,
          detail:
            "Review its activity and suspend it if this was not expected.",
          dedupeKey: `bulk_destructive:${agentId}:${bucket}`,
        }),
      );
    }
    if (row.denied >= ALERT_THRESHOLDS.permissionErrors) {
      raised += Number(
        await raiseAlert({
          ...base,
          type: "permission_errors",
          severity: "warning",
          title: `${agent.name} was refused ${row.denied} times in 15 minutes`,
          detail:
            "Repeated refusals can mean a misconfigured agent or one probing for access.",
          dedupeKey: `permission_errors:${agentId}:${bucket}`,
        }),
      );
    }

    // Volume spike: compare with the average 15-minute window over 7 days.
    if (row.total >= ALERT_THRESHOLDS.volumeMinimum) {
      const weekTotal = await AgentActivityModel.countDocuments({
        agentId: row._id,
        createdAt: { $gte: new Date(now.getTime() - 7 * DAY), $lt: since },
      });
      const average = weekTotal / ((7 * DAY) / WINDOW_MS);
      if (
        row.total >
        Math.max(
          ALERT_THRESHOLDS.volumeMinimum,
          average * ALERT_THRESHOLDS.volumeMultiplier,
        )
      ) {
        raised += Number(
          await raiseAlert({
            ...base,
            type: "volume_spike",
            severity: "warning",
            title: `${agent.name} is unusually busy`,
            detail: `${row.total} calls in 15 minutes against a usual ${average.toFixed(1)}.`,
            dedupeKey: `volume_spike:${agentId}:${bucket}`,
          }),
        );
      }
    }

    // New tools: first use of an action by an agent that already had a history.
    const hasHistory = await AgentActivityModel.exists({
      agentId: row._id,
      createdAt: { $lt: since },
    });
    for (const action of hasHistory ? row.actions.slice(0, 20) : []) {
      const seenBefore = await AgentActivityModel.exists({
        agentId: row._id,
        action,
        createdAt: { $lt: since },
      });
      if (!seenBefore) {
        raised += Number(
          await raiseAlert({
            ...base,
            type: "new_tool",
            severity: "info",
            title: `${agent.name} used ${action} for the first time`,
            detail: "New behaviour from an existing agent.",
            dedupeKey: `new_tool:${agentId}:${action}`,
          }),
        );
      }
    }

    // Off hours: changes at an hour of day this agent has not worked in 30 days.
    if (hasHistory) {
      const changes = {
        agentId: row._id,
        risk: { $ne: "read" },
        outcome: "allowed",
      };
      const [history, recent] = await Promise.all([
        AgentActivityModel.find({
          ...changes,
          createdAt: { $gte: new Date(now.getTime() - 30 * DAY), $lt: since },
        })
          .select("createdAt -_id")
          .sort({ createdAt: -1 })
          .limit(5000)
          .lean(),
        AgentActivityModel.find({
          ...changes,
          createdAt: { $gte: since, $lte: now },
        })
          .select("createdAt -_id")
          .lean(),
      ]);
      const hours = unusualHours(
        history.map((r) => r.createdAt),
        recent.map((r) => r.createdAt),
      );
      if (hours.length > 0) {
        const label = hours
          .map((h) => `${String(h).padStart(2, "0")}:00`)
          .join(", ");
        raised += Number(
          await raiseAlert({
            ...base,
            type: "off_hours",
            severity: "warning",
            title: `${agent.name} made changes at an unusual hour`,
            detail: `Changes at ${label} UTC, an hour this agent has not worked in the last 30 days.`,
            dedupeKey: `off_hours:${agentId}:${Math.floor(now.getTime() / DAY)}`,
          }),
        );
      }
    }
  }
  return raised;
}

/* ------------------------------------------------------------------ */
/* Overview, usage and compliance                                      */
/* ------------------------------------------------------------------ */

export async function workspaceOverview(workspaceIds: Types.ObjectId[]) {
  const since = new Date(Date.now() - DAY);
  const [byStatus, byKind, byRisk, activity, openAlerts, pendingApprovals] =
    await Promise.all([
      AgentModel.aggregate([
        { $match: { workspaceId: { $in: workspaceIds } } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
      AgentModel.aggregate([
        {
          $match: {
            workspaceId: { $in: workspaceIds },
            status: { $ne: "revoked" },
          },
        },
        { $group: { _id: "$kind", n: { $sum: 1 } } },
      ]),
      AgentModel.aggregate([
        {
          $match: {
            workspaceId: { $in: workspaceIds },
            status: { $ne: "revoked" },
          },
        },
        { $group: { _id: "$riskLevel", n: { $sum: 1 } } },
      ]),
      AgentActivityModel.aggregate([
        {
          $match: {
            workspaceId: { $in: workspaceIds },
            createdAt: { $gte: since },
          },
        },
        { $group: { _id: "$outcome", n: { $sum: 1 } } },
      ]),
      AgentAlertModel.countDocuments({
        workspaceId: { $in: workspaceIds },
        acknowledgedAt: null,
      }),
      AgentApprovalModel.countDocuments({
        workspaceId: { $in: workspaceIds },
        status: "pending",
        expiresAt: { $gt: new Date() },
      }),
    ]);
  const toMap = (rows: Array<{ _id: string; n: number }>) =>
    Object.fromEntries(rows.map((row) => [row._id ?? "unknown", row.n]));
  return {
    agents: toMap(byStatus),
    kinds: toMap(byKind),
    risk: toMap(byRisk),
    activity24h: toMap(activity),
    openAlerts,
    pendingApprovals,
  };
}

/** Calls, outcomes and (for AI providers) tokens and cost over the last 30 days. */
export async function agentUsage(agent: IAgentDocument) {
  const since = new Date(Date.now() - 30 * DAY);
  const [outcomes, recent] = await Promise.all([
    AgentActivityModel.aggregate([
      { $match: { agentId: agent._id, createdAt: { $gte: since } } },
      { $group: { _id: "$outcome", n: { $sum: 1 } } },
    ]),
    AgentActivityModel.find({ agentId: agent._id, createdAt: { $gte: since } })
      .select("createdAt -_id")
      .sort({ createdAt: -1 })
      .limit(20_000)
      .lean(),
  ]);
  const perDay = new Map<string, number>();
  for (const row of recent) {
    const day = row.createdAt.toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const daily = [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, calls]) => ({ date, calls }));
  let ai: {
    calls: number;
    tokens: number;
    cost: number;
    errors: number;
  } | null = null;
  if (agent.kind === "ai_provider" && agent.workspaceId) {
    const match = {
      workspaceId: oid(agent.workspaceId as Types.ObjectId),
      provider: agent.clientName,
      createdAt: { $gte: since },
    };
    const [[row], errors] = await Promise.all([
      PromptExecutionLogModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            calls: { $sum: 1 },
            tokens: { $sum: "$totalTokens" },
            cost: { $sum: "$totalCost" },
          },
        },
      ]),
      PromptExecutionLogModel.countDocuments({
        ...match,
        status: { $ne: "success" },
      }),
    ]);
    ai = row
      ? {
          calls: row.calls,
          tokens: row.tokens,
          cost: Number(row.cost.toFixed(4)),
          errors,
        }
      : { calls: 0, tokens: 0, cost: 0, errors: 0 };
  }
  return {
    outcomes: Object.fromEntries(outcomes.map((row) => [row._id, row.n])),
    daily,
    ai,
  };
}

export type ControlStatus = "met" | "partial" | "gap";

export interface ComplianceControl {
  id: string;
  framework: string;
  title: string;
  status: ControlStatus;
  evidence: string;
  recommendation: string | null;
}

export async function complianceReport(workspaceId: string) {
  const ws = oid(workspaceId);
  const [
    workspace,
    agents,
    enforced,
    advisory,
    alertsTotal,
    alertsAcked,
    approvalsDecided,
    activityCount,
  ] = await Promise.all([
    WorkspaceModel.findById(ws).select("name settings").lean(),
    AgentModel.find({ workspaceId: ws, status: { $ne: "revoked" } })
      .select(
        "name kind scopes projectIds legacy expiresAt riskLevel status ownerUserId",
      )
      .lean(),
    AgentPolicyModel.countDocuments({
      workspaceId: ws,
      enabled: true,
      mode: "enforce",
      effect: { $in: ["deny", "require_approval"] },
    }),
    AgentPolicyModel.countDocuments({
      workspaceId: ws,
      enabled: true,
      mode: "advisory",
    }),
    AgentAlertModel.countDocuments({ workspaceId: ws }),
    AgentAlertModel.countDocuments({
      workspaceId: ws,
      acknowledgedAt: { $ne: null },
    }),
    AgentApprovalModel.countDocuments({
      workspaceId: ws,
      status: { $in: ["executed", "rejected", "failed"] },
    }),
    AgentActivityModel.countDocuments({ workspaceId: ws }),
  ]);

  const active = agents.filter((agent) => agent.status === "active");
  const members = await WorkspaceMemberModel.find({ workspaceId: ws })
    .select("userId")
    .lean();
  const memberIds = new Set(members.map((m) => m.userId.toString()));
  const orphaned = active.filter(
    (agent) => !memberIds.has(agent.ownerUserId.toString()),
  );
  const keys = active.filter((agent) => agent.kind === "api_key");
  const legacy = keys.filter((agent) => agent.legacy);
  const nonExpiring = keys.filter((agent) => !agent.expiresAt);
  const admin = active.filter((agent) =>
    agent.scopes.includes("workspace:admin"),
  );
  const unscoped = active.filter(
    (agent) => agent.kind !== "ai_provider" && agent.projectIds.length === 0,
  );
  const highRisk = active.filter(
    (agent) => agent.riskLevel === "high" || agent.riskLevel === "critical",
  );
  const aiProviders = active.filter((agent) => agent.kind === "ai_provider");
  const masking = Boolean(workspace?.settings?.aiDataMasking);

  const pick = (ok: boolean, partial: boolean): ControlStatus =>
    ok ? "met" : partial ? "partial" : "gap";

  const controls: ComplianceControl[] = [
    {
      id: "inventory",
      framework: FRAMEWORKS.NIST_GOVERN,
      title: "Every agent is inventoried with an accountable owner",
      status: pick(orphaned.length === 0, orphaned.length <= 1),
      evidence: `${active.length} active agent(s); ${orphaned.length} without a current workspace member as owner.`,
      recommendation: orphaned.length
        ? "Reassign or revoke agents whose owners have left."
        : null,
    },
    {
      id: "least_privilege",
      framework: FRAMEWORKS.OWASP_EXCESSIVE_AGENCY,
      title: "Agents have only the access they need",
      status: pick(
        admin.length === 0 && unscoped.length === 0,
        admin.length === 0,
      ),
      evidence: `${admin.length} agent(s) with workspace admin; ${unscoped.length} not limited to specific projects.`,
      recommendation:
        admin.length || unscoped.length
          ? "Limit agents to the projects they work on and remove admin scope."
          : null,
    },
    {
      id: "credential_hygiene",
      framework: FRAMEWORKS.ISO_ACCESS,
      title: "API keys expire and legacy keys are retired",
      status: pick(
        legacy.length === 0 && nonExpiring.length === 0,
        legacy.length === 0,
      ),
      evidence: `${keys.length} API key(s): ${legacy.length} legacy, ${nonExpiring.length} without expiry.`,
      recommendation:
        legacy.length || nonExpiring.length
          ? "Replace legacy Sync keys with scoped agent keys that expire."
          : null,
    },
    {
      id: "human_oversight",
      framework: FRAMEWORKS.EU_OVERSIGHT,
      title: "High-impact agent actions need a person",
      status: pick(enforced > 0, advisory > 0),
      evidence: `${enforced} enforced deny or approval polic(ies); ${advisory} advisory; ${approvalsDecided} decided approval(s).`,
      recommendation: enforced
        ? null
        : "Add an enforced approval policy for destructive actions.",
    },
    {
      id: "record_keeping",
      framework: FRAMEWORKS.EU_LOGGING,
      title: "Agent actions are logged and retained",
      status: "met",
      evidence: `${activityCount} logged action(s), kept for ${AGENT_ACTIVITY_RETENTION_DAYS} days with inputs masked.`,
      recommendation: null,
    },
    {
      id: "monitoring",
      framework: FRAMEWORKS.ISO_MONITORING,
      title: "Unusual agent behaviour is detected and reviewed",
      status: pick(
        alertsTotal === 0 || alertsAcked === alertsTotal,
        alertsAcked > 0,
      ),
      evidence: `${alertsTotal} alert(s) raised, ${alertsAcked} reviewed.`,
      recommendation:
        alertsTotal > alertsAcked ? "Review open agent alerts." : null,
    },
    {
      id: "risk_assessment",
      framework: FRAMEWORKS.NIST_MEASURE,
      title: "Agent risk is assessed and acted on",
      status: pick(highRisk.length === 0, highRisk.length <= 2),
      evidence: `${highRisk.length} high or critical risk agent(s).`,
      recommendation: highRisk.length
        ? "Work through the risk factors on high-risk agents."
        : null,
    },
    {
      id: "data_protection",
      framework: FRAMEWORKS.OWASP_SENSITIVE_DATA,
      title: "Personal data is masked before it reaches AI providers",
      status: aiProviders.length === 0 ? "met" : pick(masking, false),
      evidence: masking
        ? "Masking is on for AI provider calls."
        : `${aiProviders.length} AI provider(s) receive prompts without masking.`,
      recommendation:
        masking || aiProviders.length === 0 ? null : "Turn on AI data masking.",
    },
    {
      id: "kill_switch",
      framework: FRAMEWORKS.NIST_MANAGE,
      title: "Any agent can be stopped immediately",
      status: "met",
      evidence:
        "Suspend and revoke take effect on the next call for keys, sessions and AI providers.",
      recommendation: null,
    },
  ];

  const score = Math.round(
    (controls.reduce(
      (sum, c) =>
        sum + (c.status === "met" ? 1 : c.status === "partial" ? 0.5 : 0),
      0,
    ) /
      controls.length) *
      100,
  );
  return {
    workspace: { id: workspaceId, name: workspace?.name ?? "" },
    generatedAt: new Date().toISOString(),
    score,
    controls,
    agents: agents.map((agent) => ({
      id: agent._id.toString(),
      name: agent.name,
      kind: agent.kind,
      status: agent.status,
      riskLevel: agent.riskLevel,
      scopes: agent.scopes,
      projectCount: agent.projectIds.length,
      legacy: agent.legacy,
      expiresAt: agent.expiresAt,
    })),
    disclaimer:
      "Framework mapping is guidance to support reviews; it is not a certification of compliance.",
  };
}
