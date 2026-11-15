import { Types } from "mongoose";

import {
  AgentActivityModel,
  AgentAlertModel,
  AgentApprovalModel,
  AgentIncidentModel,
  AgentModel,
  ComplianceSnapshotModel,
} from "../agents/model.js";
import { redact } from "../agents/redaction.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import { GuideExposureModel } from "../engagement/model.js";
import GuideModel from "../guides/model.js";
import ProjectModel from "../project/models/project.model.js";
import projectService from "../project/services/project.service.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";
import { SurveyModel, SurveyResponseModel } from "../surveys/model.js";
import TaskModel from "../task/models/task.model.js";
import { AutomationLinkModel } from "./model.js";

const DAY = 86_400_000;
const oid = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));
const avg = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface Scope {
  userId: string;
  workspaceId: string;
  /** Admins see the workspace; others see their own agents and projects. */
  isAdmin: boolean;
}

async function memberProjects(scope: Scope) {
  const ids = (await projectService.fetchProjects(scope.userId)).map(
    (p) => p.id,
  );
  return ProjectModel.find({
    _id: { $in: ids },
    workspaceId: oid(scope.workspaceId),
  })
    .select("_id name")
    .lean();
}

const agentFilter = (scope: Scope) => ({
  workspaceId: oid(scope.workspaceId),
  ...(scope.isAdmin ? {} : { ownerUserId: oid(scope.userId) }),
});

/* ------------------------------------------------------------------ */
/* Live health signals                                                  */
/* ------------------------------------------------------------------ */

async function guideCompletion(guideIds: string[], from: Date, to: Date) {
  const rows = await GuideExposureModel.find({
    guideId: { $in: guideIds },
    createdAt: { $gte: from, $lt: to },
  })
    .select("guideId status")
    .lean();
  const byGuide = new Map<string, { total: number; completed: number }>();
  for (const row of rows) {
    const g = byGuide.get(row.guideId) ?? { total: 0, completed: 0 };
    g.total += 1;
    if (row.status === "completed") g.completed += 1;
    byGuide.set(row.guideId, g);
  }
  const total = rows.length;
  return {
    total,
    rate: total
      ? rows.filter((r) => r.status === "completed").length / total
      : null,
    byGuide,
  };
}

export async function healthSignals(scope: Scope) {
  const now = Date.now();
  const ws = oid(scope.workspaceId);
  const projects = await memberProjects(scope);
  const projectIds = projects.map((p) => p._id);

  // SLA: share of open work that has not missed its deadline.
  const openTasks = await TaskModel.find({
    projectId: { $in: projectIds },
    status: { $nin: ["DONE", "rolled_over"] },
  })
    .select("projectId resolutionBreached currentSlaState")
    .lean();
  const perProject = new Map<string, { open: number; breached: number }>();
  for (const task of openTasks) {
    const key = String(task.projectId);
    const row = perProject.get(key) ?? { open: 0, breached: 0 };
    row.open += 1;
    if (task.resolutionBreached || task.currentSlaState === "BREACHED")
      row.breached += 1;
    perProject.set(key, row);
  }
  const breached = [...perProject.values()].reduce(
    (sum, p) => sum + p.breached,
    0,
  );
  const worstProject =
    projects
      .map((p) => ({
        id: String(p._id),
        name: String(p.name),
        ...(perProject.get(String(p._id)) ?? { open: 0, breached: 0 }),
      }))
      .filter((p) => p.breached > 0)
      .sort((a, b) => b.breached / b.open - a.breached / a.open)[0] ?? null;

  // Agents by risk.
  const agents = await AgentModel.find({
    ...agentFilter(scope),
    status: { $ne: "revoked" },
  })
    .select("riskLevel kind status")
    .lean();
  const risk = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const agent of agents)
    risk[(agent.riskLevel ?? "low") as keyof typeof risk] += 1;

  // Engagement: guide completion this week against last week, for the integrations this person owns.
  const integrations = await SdkIntegrationModel.find({
    tenantId: scope.userId,
    status: { $ne: "revoked" },
  })
    .select("_id name")
    .lean();
  const guides = await GuideModel.find({
    sdkIntegrationId: { $in: integrations.map((i) => String(i._id)) },
    status: "LIVE",
  })
    .select("_id title sdkIntegrationId")
    .lean();
  const guideIds = guides.map((g) => String(g._id));
  const [cur, prev] = guideIds.length
    ? await Promise.all([
        guideCompletion(guideIds, new Date(now - 7 * DAY), new Date(now)),
        guideCompletion(
          guideIds,
          new Date(now - 14 * DAY),
          new Date(now - 7 * DAY),
        ),
      ])
    : [null, null];
  let worstGuide: {
    id: string;
    title: string;
    integrationId: string;
    rate: number;
    previous: number | null;
  } | null = null;
  if (cur) {
    for (const guide of guides) {
      const c = cur.byGuide.get(String(guide._id));
      if (!c || c.total < 5) continue;
      const p = prev?.byGuide.get(String(guide._id));
      const rate = c.completed / c.total;
      if (!worstGuide || rate < worstGuide.rate)
        worstGuide = {
          id: String(guide._id),
          title: guide.title,
          integrationId: guide.sdkIntegrationId,
          rate,
          previous: p && p.total >= 5 ? p.completed / p.total : null,
        };
    }
  }

  // Compliance and incidents are workspace matters: admins only.
  let compliance: {
    score: number;
    change: number | null;
    failing: number;
  } | null = null;
  let incidents: number | null = null;
  if (scope.isAdmin) {
    const [latest, weekAgo] = await Promise.all([
      ComplianceSnapshotModel.findOne({ workspaceId: ws })
        .sort({ createdAt: -1 })
        .lean(),
      ComplianceSnapshotModel.findOne({
        workspaceId: ws,
        createdAt: { $lte: new Date(now - 7 * DAY) },
      })
        .sort({ createdAt: -1 })
        .lean(),
    ]);
    if (latest)
      compliance = {
        score: latest.score,
        change: weekAgo ? latest.score - weekAgo.score : null,
        failing: (latest.controls ?? []).filter((c) => c.status === "gap")
          .length,
      };
    incidents = await AgentIncidentModel.countDocuments({
      workspaceId: ws,
      status: { $ne: "resolved" },
    });
  }

  const autoTasks = await AutomationLinkModel.countDocuments({
    state: "open",
    $or: [
      { userId: oid(scope.userId) },
      ...(scope.isAdmin ? [{ workspaceId: ws }] : []),
    ],
  });

  return {
    sla: {
      open: openTasks.length,
      breached,
      health: openTasks.length ? 1 - breached / openTasks.length : null,
      worstProject,
    },
    agents: {
      total: agents.length,
      ...risk,
      unregistered: agents.filter(
        (a) => a.kind === "detected" && a.status === "active",
      ).length,
    },
    engagement: cur
      ? {
          completionRate: cur.rate,
          previousRate: prev?.rate ?? null,
          people: cur.total,
          worstGuide,
        }
      : null,
    compliance,
    incidents,
    autoTasks,
    generatedAt: new Date(now).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Governance telemetry: how well governance itself works               */
/* ------------------------------------------------------------------ */

async function governancePeriod(ws: Types.ObjectId, from: Date, to: Date) {
  const range = { $gte: from, $lt: to };
  const [shadow, shadowAlerts, approvals, incidents, actions] =
    await Promise.all([
      AgentModel.find({ workspaceId: ws, kind: "detected", createdAt: range })
        .select("status replacedByAgentId createdAt updatedAt")
        .lean(),
      AgentAlertModel.find({
        workspaceId: ws,
        type: "unregistered_agent",
        createdAt: range,
      })
        .select("agentId createdAt")
        .lean(),
      AgentApprovalModel.find({
        workspaceId: ws,
        createdAt: range,
        decidedAt: { $ne: null },
      })
        .select("createdAt decidedAt status")
        .lean(),
      AgentIncidentModel.find({ workspaceId: ws, createdAt: range })
        .select("createdAt resolvedAt timeline status")
        .lean(),
      AgentActivityModel.aggregate<{
        _id: {
          decidedBy: string | null;
          outcome: string;
          policy: string | null;
        };
        n: number;
      }>([
        { $match: { workspaceId: ws, createdAt: range } },
        {
          $group: {
            _id: {
              decidedBy: "$decidedBy",
              outcome: "$outcome",
              policy: "$policyName",
            },
            n: { $sum: 1 },
          },
        },
      ]),
    ]);

  const alertAt = new Map(
    shadowAlerts.map((a) => [
      String(a.agentId),
      new Date(a.createdAt).getTime(),
    ]),
  );
  const detectMs = shadow
    .map((a) => alertAt.get(String(a._id)))
    .map((at, i) =>
      at
        ? Math.max(0, at - new Date(shadow[i].createdAt as Date).getTime())
        : null,
    )
    .filter((v): v is number => v != null);
  const remediated = shadow.filter(
    (a) => a.status !== "active" || a.replacedByAgentId,
  );
  const remediateMs = remediated.map(
    (a) =>
      new Date(
        (a as { updatedAt?: Date }).updatedAt ?? (a.createdAt as Date),
      ).getTime() - new Date(a.createdAt as Date).getTime(),
  );
  const approvalMs = approvals.map(
    (a) =>
      new Date(a.decidedAt as Date).getTime() -
      new Date(a.createdAt as Date).getTime(),
  );
  const containMs: number[] = [];
  const resolveMs: number[] = [];
  for (const incident of incidents) {
    const contained = (incident.timeline ?? []).find(
      (e) => e.action === "contained",
    );
    if (contained)
      containMs.push(
        new Date(contained.at).getTime() -
          new Date(incident.createdAt).getTime(),
      );
    if (incident.resolvedAt)
      resolveMs.push(
        new Date(incident.resolvedAt).getTime() -
          new Date(incident.createdAt).getTime(),
      );
  }
  const total = actions.reduce((sum, a) => sum + a.n, 0);
  const byPolicy = new Map<string, number>();
  let policyHits = 0;
  const outcomes: Record<string, number> = {};
  for (const row of actions) {
    outcomes[row._id.outcome] = (outcomes[row._id.outcome] ?? 0) + row.n;
    if (row._id.policy) {
      policyHits += row.n;
      byPolicy.set(row._id.policy, (byPolicy.get(row._id.policy) ?? 0) + row.n);
    }
  }
  return {
    shadowAi: {
      detected: shadow.length,
      remediated: remediated.length,
      detectMs: avg(detectMs),
      remediateMs: avg(remediateMs),
    },
    approvals: {
      decided: approvals.length,
      averageMs: avg(approvalMs),
      medianMs: median(approvalMs),
    },
    incidents: {
      opened: incidents.length,
      containMs: avg(containMs),
      resolveMs: avg(resolveMs),
    },
    policies: {
      actions: total,
      hitRate: total ? policyHits / total : null,
      outcomes,
      top: [...byPolicy.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, hits]) => ({ name, hits })),
    },
  };
}

export async function governanceTelemetry(workspaceId: string, days = 30) {
  const ws = oid(workspaceId);
  const now = Date.now();
  const [current, previous, trend] = await Promise.all([
    governancePeriod(ws, new Date(now - days * DAY), new Date(now)),
    governancePeriod(
      ws,
      new Date(now - 2 * days * DAY),
      new Date(now - days * DAY),
    ),
    ComplianceSnapshotModel.find({
      workspaceId: ws,
      createdAt: { $gte: new Date(now - 90 * DAY) },
    })
      .sort({ createdAt: 1 })
      .select("score createdAt")
      .lean(),
  ]);
  // One point a day (the last snapshot of each day).
  const perDay = new Map<string, number>();
  for (const row of trend)
    perDay.set(new Date(row.createdAt).toISOString().slice(0, 10), row.score);
  return {
    days,
    current,
    previous,
    complianceTrend: [...perDay.entries()].map(([date, score]) => ({
      date,
      score,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Agent and AI telemetry                                               */
/* ------------------------------------------------------------------ */

export async function agentTelemetry(scope: Scope, days = 7) {
  const since = new Date(Date.now() - days * DAY);
  const agents = await AgentModel.find(agentFilter(scope))
    .select("_id name kind status riskLevel")
    .lean();
  const ids = agents.map((a) => a._id);
  const [actions, ai] = await Promise.all([
    AgentActivityModel.aggregate<{
      _id: { agentId: Types.ObjectId; outcome: string };
      n: number;
      duration: number;
    }>([
      { $match: { agentId: { $in: ids }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { agentId: "$agentId", outcome: "$outcome" },
          n: { $sum: 1 },
          duration: { $sum: "$durationMs" },
        },
      },
    ]),
    PromptExecutionLogModel.aggregate<{
      _id: Types.ObjectId;
      calls: number;
      tokens: number;
      cost: number;
      latency: number;
    }>([
      { $match: { agentId: { $in: ids }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$agentId",
          calls: { $sum: 1 },
          tokens: { $sum: "$totalTokens" },
          cost: { $sum: "$totalCost" },
          latency: { $sum: "$latencyMs" },
        },
      },
    ]),
  ]);
  const rows = new Map(
    agents.map((a) => [
      String(a._id),
      {
        id: String(a._id),
        name: String(a.name),
        kind: a.kind,
        status: a.status,
        riskLevel: a.riskLevel,
        calls: 0,
        allowed: 0,
        blocked: 0,
        held: 0,
        errors: 0,
        latencyMs: null as number | null,
        aiCalls: 0,
        tokens: 0,
        costUsd: 0,
        aiLatencyMs: null as number | null,
      },
    ]),
  );
  for (const row of actions) {
    const r = rows.get(String(row._id.agentId));
    if (!r) continue;
    r.calls += row.n;
    if (row._id.outcome === "allowed") {
      r.allowed += row.n;
      // Average over allowed calls that recorded a duration (sum / count keeps this to one pass).
      if (row.duration > 0) r.latencyMs = Math.round(row.duration / row.n);
    } else if (row._id.outcome === "blocked") r.blocked += row.n;
    else if (row._id.outcome === "pending_approval") r.held += row.n;
    else if (row._id.outcome === "error") r.errors += row.n;
  }
  for (const row of ai) {
    const r = rows.get(String(row._id));
    if (!r) continue;
    r.aiCalls = row.calls;
    r.tokens = row.tokens;
    r.costUsd = Math.round(row.cost * 100) / 100;
    r.aiLatencyMs =
      row.latency > 0 && row.calls > 0
        ? Math.round(row.latency / row.calls)
        : null;
  }
  const list = [...rows.values()]
    .filter((r) => r.calls > 0 || r.aiCalls > 0 || r.status === "active")
    .sort((a, b) => b.calls + b.aiCalls - (a.calls + a.aiCalls));
  return {
    days,
    agents: list.slice(0, 100),
    totals: list.reduce(
      (t, r) => ({
        calls: t.calls + r.calls,
        blocked: t.blocked + r.blocked,
        held: t.held + r.held,
        costUsd: Math.round((t.costUsd + r.costUsd) * 100) / 100,
        tokens: t.tokens + r.tokens,
      }),
      { calls: 0, blocked: 0, held: 0, costUsd: 0, tokens: 0 },
    ),
  };
}

/* ------------------------------------------------------------------ */
/* What one end user or session did                                     */
/* ------------------------------------------------------------------ */

async function ownIntegration(userId: string, integrationId: string) {
  if (!Types.ObjectId.isValid(integrationId)) return null;
  return SdkIntegrationModel.findOne({ _id: integrationId, tenantId: userId })
    .select("_id name")
    .lean();
}

/** People recently seen in an integration, newest first. */
export async function recentPeople(
  userId: string,
  integrationId: string,
  search?: string,
) {
  if (!(await ownIntegration(userId, integrationId))) return null;
  const filter: Record<string, unknown> = {
    sdkIntegrationId: integrationId,
    userIdentifier: { $nin: [null, ""] },
  };
  if (search)
    filter.userIdentifier = {
      $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
  const logs = await AnalyticsLogModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(2000)
    .select("userIdentifier sessionId createdAt")
    .lean();
  const people = new Map<
    string,
    { user: string; lastSeen: string; events: number; sessions: Set<string> }
  >();
  for (const log of logs) {
    const user = String(log.userIdentifier);
    const row = people.get(user) ?? {
      user,
      lastSeen: new Date(log.createdAt).toISOString(),
      events: 0,
      sessions: new Set<string>(),
    };
    row.events += 1;
    if (log.sessionId) row.sessions.add(log.sessionId);
    people.set(user, row);
  }
  return [...people.values()]
    .slice(0, 50)
    .map((p) => ({
      user: p.user,
      lastSeen: p.lastSeen,
      events: p.events,
      sessions: p.sessions.size,
    }));
}

export interface JourneyItem {
  at: string;
  kind: "event" | "guide" | "survey";
  title: string;
  detail?: string;
  sessionId?: string | null;
  /** Event properties with personal data and secrets masked. */
  properties?: unknown;
  link: string;
}

/** Everything one person (or one session) did, oldest first: events, guide steps and survey answers. */
export async function journey(
  userId: string,
  integrationId: string,
  who: { user?: string; session?: string },
): Promise<{
  items: JourneyItem[];
  summary: {
    events: number;
    guidesCompleted: number;
    guidesLeft: number;
    surveys: number;
    firstSeen: string | null;
    lastSeen: string | null;
  };
} | null> {
  if (!(await ownIntegration(userId, integrationId))) return null;
  if (!who.user && !who.session)
    return {
      items: [],
      summary: {
        events: 0,
        guidesCompleted: 0,
        guidesLeft: 0,
        surveys: 0,
        firstSeen: null,
        lastSeen: null,
      },
    };
  const logFilter = {
    sdkIntegrationId: integrationId,
    ...(who.user ? { userIdentifier: who.user } : { sessionId: who.session }),
  };
  const idFilter = {
    sdkIntegrationId: integrationId,
    ...(who.user ? { userId: who.user } : { sessionId: who.session }),
  };
  const [logs, exposures, responses] = await Promise.all([
    AnalyticsLogModel.find(logFilter).sort({ createdAt: -1 }).limit(300).lean(),
    GuideExposureModel.find(idFilter).sort({ updatedAt: -1 }).limit(100).lean(),
    SurveyResponseModel.find(idFilter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  ]);
  const [guides, surveys] = await Promise.all([
    GuideModel.find({
      _id: {
        $in: [...new Set(exposures.map((e) => e.guideId))].filter((id) =>
          Types.ObjectId.isValid(id),
        ),
      },
    })
      .select("_id title steps")
      .lean(),
    SurveyModel.find({
      _id: {
        $in: [...new Set(responses.map((r) => r.surveyId))].filter((id) =>
          Types.ObjectId.isValid(id),
        ),
      },
    })
      .select("_id title")
      .lean(),
  ]);
  const guideById = new Map(guides.map((g) => [String(g._id), g]));
  const surveyById = new Map(surveys.map((s) => [String(s._id), s]));
  const items: JourneyItem[] = [];
  for (const log of logs) {
    items.push({
      at: new Date(log.createdAt).toISOString(),
      kind: "event",
      title: log.eventName ?? "event",
      sessionId: log.sessionId ?? null,
      properties: redact(log.payload ?? {}),
      link: `/sdk-integrations/${integrationId}/events`,
    });
  }
  let guidesCompleted = 0;
  let guidesLeft = 0;
  for (const exposure of exposures) {
    const guide = guideById.get(exposure.guideId);
    const name = guide?.title ?? "a guide";
    const steps = guide?.steps ?? [];
    const stepIndex = steps.findIndex((s) => s.id === exposure.currentStepId);
    const stepLabel =
      stepIndex >= 0
        ? `step ${stepIndex + 1} of ${steps.length} ("${steps[stepIndex].title}")`
        : null;
    const link = `/sdk-integrations/${integrationId}/guides?analytics=${exposure.guideId}`;
    const startedAt = exposure.startedAt ?? exposure.createdAt;
    if (startedAt)
      items.push({
        at: new Date(startedAt).toISOString(),
        kind: "guide",
        title: `Started ${name}`,
        sessionId: exposure.sessionId ?? null,
        link,
      });
    if (exposure.status === "completed") {
      guidesCompleted += 1;
      items.push({
        at: new Date(
          exposure.completedAt ?? exposure.updatedAt ?? new Date(),
        ).toISOString(),
        kind: "guide",
        title: `Completed ${name}`,
        sessionId: exposure.sessionId ?? null,
        link,
      });
    } else if (
      exposure.status === "dismissed" ||
      exposure.status === "abandoned"
    ) {
      guidesLeft += 1;
      items.push({
        at: new Date(
          exposure.dismissedAt ??
            exposure.lastInteractionAt ??
            exposure.updatedAt ??
            new Date(),
        ).toISOString(),
        kind: "guide",
        title: `Left ${name}`,
        detail: stepLabel ? `at ${stepLabel}` : undefined,
        sessionId: exposure.sessionId ?? null,
        link,
      });
    } else if (stepLabel) {
      guidesLeft += 1;
      items.push({
        at: new Date(
          exposure.lastInteractionAt ?? exposure.updatedAt ?? new Date(),
        ).toISOString(),
        kind: "guide",
        title: `Stopped in ${name}`,
        detail: `at ${stepLabel}; no further steps`,
        sessionId: exposure.sessionId ?? null,
        link,
      });
    }
  }
  for (const response of responses) {
    const survey = surveyById.get(response.surveyId);
    items.push({
      at: new Date(
        (response as { createdAt?: Date }).createdAt ?? new Date(),
      ).toISOString(),
      kind: "survey",
      title: `Answered ${survey?.title ?? "a survey"}`,
      detail:
        response.npsScore != null
          ? `score ${response.npsScore}`
          : `${(response.answers ?? []).length} answer(s)`,
      sessionId: response.sessionId ?? null,
      link: `/sdk-integrations/${integrationId}/surveys?analytics=${response.surveyId}`,
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  return {
    items,
    summary: {
      events: logs.length,
      guidesCompleted,
      guidesLeft,
      surveys: responses.length,
      firstSeen: items[0]?.at ?? null,
      lastSeen: items[items.length - 1]?.at ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tasks the system opened, and what came of them                       */
/* ------------------------------------------------------------------ */

export async function automationTasks(scope: Scope) {
  const links = await AutomationLinkModel.find({
    $or: [
      { userId: oid(scope.userId) },
      ...(scope.isAdmin ? [{ workspaceId: oid(scope.workspaceId) }] : []),
    ],
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const tasks = await TaskModel.find({
    _id: { $in: links.map((l) => l.taskId) },
  })
    .select("_id status priority")
    .lean();
  const taskById = new Map(tasks.map((t) => [String(t._id), t]));
  return links.map((l) => {
    const task = taskById.get(String(l.taskId));
    return {
      id: String(l._id),
      rule: l.rule,
      title: l.title,
      state: l.state === "open" ? "open" : "closed",
      closedBy: l.closedBy ?? null,
      taskId: String(l.taskId),
      taskExists: Boolean(task),
      taskStatus: task?.status ?? null,
      priority: task?.priority ?? null,
      projectId: l.projectId ? String(l.projectId) : null,
      sourceLink: l.link,
      escalated: Boolean(l.escalatedAt),
      metric: l.metric ?? null,
      result: l.result ?? null,
      remeasureAt: l.remeasureAt ?? null,
      createdAt: l.createdAt,
      closedAt: l.closedAt ?? null,
    };
  });
}

/** The automation record behind a task, if the system opened it. */
export async function automationForTask(taskId: string) {
  if (!Types.ObjectId.isValid(taskId)) return null;
  const l = await AutomationLinkModel.findOne({ taskId: oid(taskId) }).lean();
  if (!l) return null;
  return {
    rule: l.rule,
    sourceLink: l.link,
    state: l.state,
    closedBy: l.closedBy ?? null,
    metric: l.metric ?? null,
    result: l.result ?? null,
    remeasureAt: l.remeasureAt ?? null,
    createdAt: l.createdAt,
  };
}
