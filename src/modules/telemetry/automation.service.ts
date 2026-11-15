import { Types } from "mongoose";

import env from "../../config/env.js";
import logger from "../../lib/logger.js";
import agentService from "../agents/agent.service.js";
import { logGovernanceEvent } from "../agents/hybrid.service.js";
import {
  AgentIncidentModel,
  AgentModel,
  ComplianceSnapshotModel,
} from "../agents/model.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import { GuideExposureModel } from "../engagement/model.js";
import GuideModel from "../guides/model.js";
import { stepFunnel } from "../guides/step-funnel.js";
import ProjectModel from "../project/models/project.model.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";
import { SurveyModel, SurveyResponseModel } from "../surveys/model.js";
import TaskModel from "../task/models/task.model.js";
import taskService from "../task/services/task.service.js";
import { VendorModel } from "../vendors/model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import {
  AUTOMATION_RULES,
  GOVERNANCE_CHECKLIST,
  INCIDENT_STEPS,
  SHADOW_STEPS,
  describeTask,
  droppedBy,
  formatMetric,
  normalizeAutomation,
  outcomeOf,
  pct,
  ruleOn,
  spiked,
  toFivePoint,
  worstStep,
  type AutomationRule,
  type AutomationSettings,
  type Finding,
} from "./automation.js";
import { AutomationLinkModel, type IAutomationLinkDocument } from "./model.js";

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const ESCALATE_AFTER_DAYS = 3;
/** New tasks one sweep may open for one workspace or person, so a bad day cannot flood a board. */
const MAX_NEW_PER_SWEEP = 10;
const SCORED_QUESTIONS = ["CSAT", "RATING_SCALE", "OPINION_SCALE", "CES"];
const WORKSPACE_RULES: AutomationRule[] = [
  "shadow_ai",
  "compliance_gap",
  "incident",
  "key_expiry",
  "vendor_review",
  "sla_breaches",
];
const TENANT_RULES: AutomationRule[] = [
  "guide_dropoff",
  "guide_completion_drop",
  "survey_score",
  "event_spike",
];
const RULE_LABEL = new Map(AUTOMATION_RULES.map((r) => [r.id, r.label]));
const today = () => new Date().toISOString().slice(0, 10);
const oid = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));

export async function automationSettings(
  workspaceId: string | null | undefined,
): Promise<AutomationSettings> {
  if (!workspaceId) return normalizeAutomation(undefined);
  const ws = await WorkspaceModel.findById(workspaceId)
    .select("settings.automation")
    .lean();
  return normalizeAutomation(
    (ws?.settings as { automation?: unknown } | undefined)?.automation,
  );
}

export async function saveAutomationSettings(
  workspaceId: string,
  patch: Record<string, unknown>,
): Promise<AutomationSettings> {
  const current = await automationSettings(workspaceId);
  const next = normalizeAutomation({
    ...current,
    ...patch,
    rules: { ...current.rules, ...((patch.rules as object) ?? {}) },
  });
  if (patch.projectId === null || patch.projectId === "") next.projectId = null;
  await WorkspaceModel.updateOne(
    { _id: workspaceId },
    { $set: { "settings.automation": next } },
  );
  return next;
}

/* ------------------------------------------------------------------ */
/* Findings                                                             */
/* ------------------------------------------------------------------ */

/** The start of the data a metric rule looks at: 30 days, or since the last task for the same thing was closed. */
async function windowStart(
  rule: AutomationRule,
  contextKey: string,
  contextValue: string,
): Promise<Date> {
  const last = await AutomationLinkModel.findOne({
    rule,
    [`context.${contextKey}`]: contextValue,
    closedAt: { $ne: null },
  })
    .sort({ closedAt: -1 })
    .select("closedAt")
    .lean();
  const floor = new Date(Date.now() - WINDOW_DAYS * DAY);
  return last?.closedAt && last.closedAt > floor ? last.closedAt : floor;
}

async function guideDropOff(
  guide: { _id: unknown; steps?: Array<{ id: string; title?: string }> },
  since: Date,
) {
  const exposures = await GuideExposureModel.find({
    guideId: String(guide._id),
    createdAt: { $gte: since },
  })
    .select("status currentStepId")
    .lean();
  return {
    funnel: stepFunnel(guide.steps ?? [], exposures),
    sample: exposures.length,
  };
}

async function surveyAverage(
  surveyId: string,
  question: { id: string; min?: number; max?: number },
  since: Date,
) {
  const responses = await SurveyResponseModel.find({
    surveyId,
    createdAt: { $gte: since },
  })
    .select("answers")
    .lean();
  const scores: number[] = [];
  for (const response of responses) {
    const answers = (response.answers ?? []) as Array<{
      questionId: string;
      value?: unknown;
    }>;
    const answer = answers.find((a) => a.questionId === question.id);
    const five = answer
      ? toFivePoint(Number(answer.value), question.min ?? 1, question.max ?? 5)
      : null;
    if (five != null) scores.push(five);
  }
  return {
    average: scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0,
    sample: scores.length,
  };
}

async function completionRate(guideId: string, from: Date, to: Date) {
  const rows = await GuideExposureModel.find({
    guideId,
    createdAt: { $gte: from, $lt: to },
  })
    .select("status")
    .lean();
  return {
    rate: rows.length
      ? rows.filter((r) => r.status === "completed").length / rows.length
      : 0,
    sample: rows.length,
  };
}

async function breachedBetween(
  projectId: Types.ObjectId,
  from: Date,
  to: Date,
): Promise<number> {
  return TaskModel.countDocuments({
    projectId,
    resolutionBreached: true,
    slaResolutionDueAt: { $gte: from, $lt: to },
  });
}

/** Product telemetry of the integrations one person owns. */
export async function tenantFindings(
  userId: string,
  settings: AutomationSettings,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const integrations = await SdkIntegrationModel.find({
    tenantId: userId,
    status: { $ne: "revoked" },
  })
    .select("_id name")
    .lean();
  const now = Date.now();
  for (const integration of integrations) {
    const iid = String(integration._id);
    const guides =
      ruleOn(settings, "guide_dropoff") ||
      ruleOn(settings, "guide_completion_drop")
        ? await GuideModel.find({ sdkIntegrationId: iid, status: "LIVE" })
            .select("_id title steps")
            .lean()
        : [];
    for (const guide of guides) {
      const gid = String(guide._id);
      const link = `/sdk-integrations/${iid}/guides?analytics=${gid}`;
      if (ruleOn(settings, "guide_dropoff")) {
        const { funnel } = await guideDropOff(
          guide,
          await windowStart("guide_dropoff", "guideId", gid),
        );
        const worst = worstStep(
          funnel,
          settings.dropOffThreshold,
          settings.minSample,
        );
        if (worst) {
          out.push({
            rule: "guide_dropoff",
            key: `guide_dropoff:${gid}:${worst.stepId}`,
            title: `Reduce drop-off at "${worst.title}" in ${guide.title}`,
            description: `${pct(worst.dropOffRate)} of the ${worst.reached} people who reached step ${worst.index + 1} ("${worst.title}") of the guide "${guide.title}" left there. The threshold is ${pct(settings.dropOffThreshold)}.`,
            priority: worst.dropOffRate >= 0.6 ? "HIGH" : "MEDIUM",
            assigneeUserId: userId,
            link,
            metric: {
              name: `Drop-off at step ${worst.index + 1}`,
              unit: "percent",
              value: worst.dropOffRate,
              lowerIsBetter: true,
            },
            context: { integrationId: iid, guideId: gid, stepId: worst.stepId },
          });
        }
      }
      if (ruleOn(settings, "guide_completion_drop")) {
        const [cur, prev] = await Promise.all([
          completionRate(gid, new Date(now - 7 * DAY), new Date(now)),
          completionRate(
            gid,
            new Date(now - 14 * DAY),
            new Date(now - 7 * DAY),
          ),
        ]);
        if (
          cur.sample >= settings.minSample &&
          prev.sample >= settings.minSample &&
          droppedBy(prev.rate, cur.rate, 0.3)
        ) {
          out.push({
            rule: "guide_completion_drop",
            key: `guide_completion_drop:${gid}`,
            title: `Completion of ${guide.title} fell to ${pct(cur.rate)}`,
            description: `The guide "${guide.title}" was completed by ${pct(cur.rate)} of people in the last 7 days, down from ${pct(prev.rate)} the week before (${cur.sample} and ${prev.sample} people).`,
            priority: "HIGH",
            assigneeUserId: userId,
            link,
            metric: {
              name: "Completion rate",
              unit: "percent",
              value: cur.rate,
              lowerIsBetter: false,
            },
            context: { integrationId: iid, guideId: gid },
          });
        }
      }
    }
    if (ruleOn(settings, "survey_score")) {
      const surveys = await SurveyModel.find({
        sdkIntegrationId: iid,
        status: "LIVE",
      })
        .select("_id title questions")
        .lean();
      for (const survey of surveys) {
        const sid = String(survey._id);
        const since = await windowStart("survey_score", "surveyId", sid);
        for (const question of (survey.questions ?? []).filter((q) =>
          SCORED_QUESTIONS.includes(q.type),
        )) {
          const { average, sample } = await surveyAverage(sid, question, since);
          if (
            sample >= settings.minSample &&
            average < settings.surveyScoreThreshold
          ) {
            out.push({
              rule: "survey_score",
              key: `survey_score:${sid}:${question.id}`,
              title: `Investigate low score in ${survey.title}`,
              description: `"${question.title}" in the survey "${survey.title}" averages ${average.toFixed(1)} out of 5 across ${sample} answers. The threshold is ${settings.surveyScoreThreshold.toFixed(1)}.`,
              priority: "HIGH",
              assigneeUserId: userId,
              link: `/sdk-integrations/${iid}/surveys?analytics=${sid}`,
              metric: {
                name: "Average score (out of 5)",
                unit: "score",
                value: average,
                lowerIsBetter: false,
              },
              context: {
                integrationId: iid,
                surveyId: sid,
                questionId: question.id,
              },
            });
          }
        }
      }
    }
    if (ruleOn(settings, "event_spike")) {
      const [last24, prior] = await Promise.all([
        AnalyticsLogModel.countDocuments({
          sdkIntegrationId: iid,
          createdAt: { $gte: new Date(now - DAY) },
        }),
        AnalyticsLogModel.countDocuments({
          sdkIntegrationId: iid,
          createdAt: {
            $gte: new Date(now - 8 * DAY),
            $lt: new Date(now - DAY),
          },
        }),
      ]);
      if (spiked(prior / 7, last24, 10, 200)) {
        out.push({
          rule: "event_spike",
          key: `event_spike:${iid}:${today()}`,
          title: `${integration.name} is sending ${Math.round(last24 / (prior / 7))}× its usual events`,
          description: `${last24} events in the last 24 hours against a usual ${Math.round(prior / 7)} a day. Check for a tracking loop, a bot or a release that changed what is tracked.`,
          priority: "HIGH",
          assigneeUserId: userId,
          link: `/sdk-integrations/${iid}/events`,
          context: { integrationId: iid },
        });
      }
    }
  }
  return out;
}

/** Governance state and SLA health of one workspace. */
export async function workspaceFindings(
  workspaceId: string,
  settings: AutomationSettings,
): Promise<Finding[]> {
  const ws = oid(workspaceId);
  const workspace = await WorkspaceModel.findById(ws).select("ownerId").lean();
  if (!workspace) return [];
  const owner = String(workspace.ownerId);
  const out: Finding[] = [];
  const now = Date.now();

  if (ruleOn(settings, "shadow_ai")) {
    const agents = await AgentModel.find({
      workspaceId: ws,
      kind: "detected",
      replacedByAgentId: null,
      // Still unresolved while the system holds it suspended: only a
      // person's decision (its own key, or a block) settles it.
      $or: [
        { status: "active" },
        { status: "suspended", suspendedBySystem: true },
      ],
    })
      .select("_id name ownerUserId userAgent")
      .lean();
    for (const agent of agents) {
      out.push({
        rule: "shadow_ai",
        key: `shadow_ai:${agent._id}`,
        title: `Give ${agent.name} its own key or block it`,
        description: `${agent.name} is using a person's login instead of an agent key, so it has that person's full access and its actions are hard to tell apart from theirs. Open it in Agent Governance and choose "Give it its own key" or "Block".`,
        priority: "HIGH",
        assigneeUserId: String(agent.ownerUserId ?? owner),
        link: `/agents/inventory?agent=${agent._id}`,
        subtasks: SHADOW_STEPS.map((title) => ({ title })),
      });
    }
  }
  if (ruleOn(settings, "key_expiry")) {
    const agents = await AgentModel.find({
      workspaceId: ws,
      kind: "api_key",
      status: "active",
      expiresAt: { $gt: new Date(now), $lte: new Date(now + 7 * DAY) },
    })
      .select("_id name ownerUserId expiresAt")
      .lean();
    for (const agent of agents) {
      const expires = new Date(agent.expiresAt as Date)
        .toISOString()
        .slice(0, 10);
      out.push({
        rule: "key_expiry",
        key: `key_expiry:${agent._id}:${expires}`,
        title: `Rotate the key for ${agent.name} before ${expires}`,
        description: `The agent key for ${agent.name} expires on ${expires}. Rotate it in Agent Governance (the old key keeps working for the overlap you choose) and update wherever the key is used.`,
        priority: "MEDIUM",
        assigneeUserId: String(agent.ownerUserId ?? owner),
        link: `/agents/inventory?agent=${agent._id}`,
      });
    }
  }
  if (ruleOn(settings, "vendor_review")) {
    const vendors = await VendorModel.find({
      workspaceId: ws,
      status: "under_review",
    })
      .select("_id name")
      .lean();
    for (const vendor of vendors) {
      out.push({
        rule: "vendor_review",
        key: `vendor_review:${vendor._id}`,
        title: `Review the third party ${vendor.name}`,
        description: `${vendor.name} is in use and has not been reviewed. Complete its assessment, then approve, restrict or block it.`,
        priority: "MEDIUM",
        assigneeUserId: owner,
        link: `/agents/vendors`,
      });
    }
  }
  if (ruleOn(settings, "incident")) {
    const incidents = await AgentIncidentModel.find({
      workspaceId: ws,
      status: { $ne: "resolved" },
    })
      .select("_id title severity status summary")
      .lean();
    for (const incident of incidents) {
      out.push({
        rule: "incident",
        key: `incident:${incident._id}`,
        title: `Incident: ${incident.title}`,
        description: `${incident.summary}${incident.status === "contained" ? "\n\nThe system has already suspended the agent." : ""}`,
        priority: incident.severity === "critical" ? "CRITICAL" : "HIGH",
        assigneeUserId: owner,
        link: `/agents/incidents?incident=${incident._id}`,
        subtasks: INCIDENT_STEPS.map((title, index) => ({
          title,
          done: index === 1 && incident.status === "contained",
        })),
      });
    }
  }
  if (ruleOn(settings, "compliance_gap")) {
    const snapshot = await ComplianceSnapshotModel.findOne({ workspaceId: ws })
      .sort({ createdAt: -1 })
      .lean();
    for (const control of snapshot?.controls ?? []) {
      if (control.status !== "gap") continue;
      out.push({
        rule: "compliance_gap",
        key: `compliance_gap:${workspaceId}:${control.id}`,
        title: `Fix compliance gap: ${control.title}`,
        description: `The compliance control "${control.title}" is failing. Open Compliance in Agent Governance for the evidence and the recommended fix. This task closes by itself when the control passes.`,
        priority: "MEDIUM",
        assigneeUserId: owner,
        link: `/agents/compliance`,
      });
    }
  }
  if (ruleOn(settings, "sla_breaches")) {
    const projects = await ProjectModel.find({ workspaceId: ws })
      .select("_id name userId")
      .lean();
    for (const project of projects) {
      const [cur, prev] = await Promise.all([
        breachedBetween(
          project._id as Types.ObjectId,
          new Date(now - 7 * DAY),
          new Date(now),
        ),
        breachedBetween(
          project._id as Types.ObjectId,
          new Date(now - 14 * DAY),
          new Date(now - 7 * DAY),
        ),
      ]);
      if (cur >= 5 && cur >= prev * 2) {
        out.push({
          rule: "sla_breaches",
          key: `sla_breaches:${project._id}`,
          title: `Review SLA risk in ${project.name}`,
          description: `${cur} tasks in ${project.name} missed their resolution deadline in the last 7 days, against ${prev} the week before.`,
          priority: "HIGH",
          assigneeUserId: String(project.userId),
          projectId: String(project._id),
          link: `/projects/${project._id}`,
          metric: {
            name: "SLA breaches in 7 days",
            unit: "count",
            value: cur,
            lowerIsBetter: true,
          },
          context: { projectId: String(project._id) },
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

export const taskLink = (taskId: string, projectId?: string | null): string =>
  projectId
    ? `/projects/${projectId}?task=${taskId}`
    : `/dashboard?task=${taskId}`;

async function openTask(
  finding: Finding,
  workspaceId: string | null,
  settings: AutomationSettings,
): Promise<IAutomationLinkDocument | null> {
  const subtasks = (finding.subtasks ?? []).map((s) => ({
    title: s.title,
    status: s.done ? ("DONE" as const) : ("TODO" as const),
    completed: Boolean(s.done),
    completedAt: s.done ? new Date() : null,
  }));
  const base = {
    userId: finding.assigneeUserId,
    assignedTo: finding.assigneeUserId,
    title: finding.title.slice(0, 200),
    description: describeTask(finding, env.FRONTEND_BASE_URL),
    date: today(),
    priority: finding.priority,
    source: "automation",
    subtasks,
  };
  const preferred = finding.projectId ?? settings.projectId;
  let task;
  try {
    task = await taskService.createTask({
      ...base,
      projectId: preferred ?? null,
    });
  } catch (error) {
    if (!preferred) throw error;
    // The assignee is not in the triage project: the task goes to their own list instead.
    task = await taskService.createTask({ ...base, projectId: null });
  }
  const projectId = task.projectId ? String(task.projectId) : null;
  const link = await AutomationLinkModel.create({
    workspaceId: workspaceId ? oid(workspaceId) : null,
    userId: oid(finding.assigneeUserId),
    rule: finding.rule,
    key: finding.key,
    taskId: oid(task.id),
    projectId: projectId ? oid(projectId) : null,
    title: finding.title,
    link: finding.link,
    metric: finding.metric ?? null,
    context: finding.context ?? {},
  });
  await logGovernanceEvent({
    workspaceId,
    type: "auto_task_created",
    actor: "system",
    title: `Task opened: ${finding.title}`,
    detail: RULE_LABEL.get(finding.rule) ?? finding.rule,
    link: taskLink(task.id, projectId),
  });
  return link;
}

/** Marks the task done for the system, with a note saying why. */
async function closeTask(
  link: IAutomationLinkDocument,
  reason: string,
): Promise<void> {
  const task = await TaskModel.findById(link.taskId);
  const now = new Date();
  if (task && task.status !== "DONE") {
    task.status = "DONE";
    task.completedAt = now;
    task.currentSlaState = "COMPLETED";
    for (const sub of task.subtasks ?? []) {
      sub.status = "DONE";
      sub.completed = true;
      sub.completedAt = sub.completedAt ?? now;
    }
    task.note = [task.note, `Closed automatically by Pristine: ${reason}`]
      .filter(Boolean)
      .join("\n");
    await task.save();
  }
  link.state = "cleared";
  link.closedBy = "system";
  link.closedAt = now;
  await link.save();
  await logGovernanceEvent({
    workspaceId: link.workspaceId ? String(link.workspaceId) : null,
    type: "auto_task_closed",
    actor: "system",
    title: `Task closed: ${link.title}`,
    detail: reason,
    link: taskLink(
      String(link.taskId),
      link.projectId ? String(link.projectId) : null,
    ),
  });
}

/** Ticks subtasks the system knows are done (e.g. "Contain the agent" once it is suspended). */
async function syncSubtasks(
  link: IAutomationLinkDocument,
  wanted: Array<{ title: string; done?: boolean }>,
): Promise<void> {
  const done = new Set(wanted.filter((s) => s.done).map((s) => s.title));
  if (!done.size) return;
  const task = await TaskModel.findById(link.taskId);
  if (!task || task.status === "DONE") return;
  let changed = false;
  for (const sub of task.subtasks ?? []) {
    if (done.has(sub.title) && !sub.completed) {
      sub.completed = true;
      sub.status = "DONE";
      sub.completedAt = new Date();
      changed = true;
    }
  }
  if (changed) await task.save();
}

const CLEARED_REASON: Partial<Record<AutomationRule, string>> = {
  shadow_ai: "the tool now has its own key or is blocked.",
  compliance_gap: "the control now passes.",
  incident: "the incident was resolved.",
  key_expiry: "the key was rotated or is no longer in use.",
  vendor_review: "the third party was reviewed.",
  sla_breaches: "SLA breaches are back to normal.",
  guide_dropoff: "drop-off at this step is back under the threshold.",
  guide_completion_drop: "completion has recovered.",
  survey_score: "the score is back above the threshold.",
  event_spike: "event volume is back to normal.",
};

/**
 * Makes tasks match findings for one scope: opens a task for each new
 * condition, closes tasks whose condition cleared, notices tasks a person
 * finished, and escalates ones nobody acted on.
 */
async function reconcile(
  scope: { workspaceId: string | null; userId?: string },
  rules: AutomationRule[],
  findings: Finding[],
  settings: AutomationSettings,
) {
  const filter = scope.userId
    ? { userId: oid(scope.userId), rule: { $in: rules } }
    : { workspaceId: oid(scope.workspaceId as string), rule: { $in: rules } };
  const active = await AutomationLinkModel.find({
    ...filter,
    state: { $in: ["open", "done"] },
  });
  const byKey = new Map(active.map((l) => [l.key, l]));
  const wanted = new Map(findings.map((f) => [f.key, f]));
  const counts = { opened: 0, closed: 0, completedByPerson: 0, escalated: 0 };

  // Tasks people finished or removed.
  const tasks = await TaskModel.find({
    _id: { $in: active.filter((l) => l.state === "open").map((l) => l.taskId) },
  })
    .select("_id status completedAt priority")
    .lean();
  const taskById = new Map(tasks.map((t) => [String(t._id), t]));
  for (const link of active) {
    if (link.state !== "open") continue;
    const task = taskById.get(String(link.taskId));
    if (task && task.status !== "DONE") continue;
    link.state = "done";
    link.closedBy = "person";
    link.closedAt = task?.completedAt ?? new Date();
    // Feedback loop: measure the metric again once the fix has had time to show.
    if (task && link.metric)
      link.remeasureAt = new Date(
        link.closedAt.getTime() + settings.remeasureDays * DAY,
      );
    await link.save();
    counts.completedByPerson += 1;
  }

  for (const link of active) {
    const finding = wanted.get(link.key);
    if (finding) {
      if (link.state === "open") {
        if (finding.subtasks) await syncSubtasks(link, finding.subtasks);
        const age = Date.now() - new Date(link.createdAt).getTime();
        if (
          !link.escalatedAt &&
          age > ESCALATE_AFTER_DAYS * DAY &&
          (link.rule === "shadow_ai" || link.rule === "incident")
        ) {
          await TaskModel.updateOne(
            { _id: link.taskId, status: { $ne: "DONE" } },
            {
              $set: {
                priority: "CRITICAL",
                basePriority: "CRITICAL",
                priorityEscalatedAt: new Date(),
                priorityEscalationReason: `No action for ${ESCALATE_AFTER_DAYS} days`,
              },
            },
          );
          link.escalatedAt = new Date();
          await link.save();
          await logGovernanceEvent({
            workspaceId: scope.workspaceId,
            type: "auto_task_escalated",
            actor: "system",
            title: `Escalated: ${link.title}`,
            detail: `No action for ${ESCALATE_AFTER_DAYS} days; now critical.`,
            link: taskLink(
              String(link.taskId),
              link.projectId ? String(link.projectId) : null,
            ),
          });
          counts.escalated += 1;
        }
      }
      continue;
    }
    // The condition is gone.
    if (link.state === "open") {
      await closeTask(
        link,
        CLEARED_REASON[link.rule] ?? "the condition no longer applies.",
      );
      counts.closed += 1;
    } else if (!link.remeasureAt) {
      link.state = "cleared";
      await link.save();
    }
  }

  for (const finding of findings) {
    if (byKey.has(finding.key) || counts.opened >= MAX_NEW_PER_SWEEP) continue;
    try {
      await openTask(finding, scope.workspaceId, settings);
      counts.opened += 1;
    } catch (error) {
      logger.warn("Could not open an automation task", {
        key: finding.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Feedback loop                                                        */
/* ------------------------------------------------------------------ */

async function measureAgain(
  link: IAutomationLinkDocument,
  minSample: number,
): Promise<{ value: number; sample: number } | null> {
  const since = link.closedAt ?? new Date();
  const c = link.context ?? {};
  if (link.rule === "guide_dropoff") {
    const guide = await GuideModel.findById(c.guideId)
      .select("_id steps")
      .lean();
    if (!guide) return null;
    const { funnel } = await guideDropOff(guide, since);
    const step = funnel.find((s) => s.stepId === c.stepId);
    return step && step.reached >= minSample
      ? { value: step.dropOffRate, sample: step.reached }
      : null;
  }
  if (link.rule === "guide_completion_drop") {
    const r = await completionRate(c.guideId, since, new Date());
    return r.sample >= minSample ? { value: r.rate, sample: r.sample } : null;
  }
  if (link.rule === "survey_score") {
    const survey = await SurveyModel.findById(c.surveyId)
      .select("questions")
      .lean();
    const question = survey?.questions?.find((q) => q.id === c.questionId);
    if (!question) return null;
    const r = await surveyAverage(c.surveyId, question, since);
    return r.sample >= minSample
      ? { value: r.average, sample: r.sample }
      : null;
  }
  if (link.rule === "sla_breaches") {
    const value = await breachedBetween(
      oid(c.projectId),
      new Date(Date.now() - 7 * DAY),
      new Date(),
    );
    return { value, sample: value };
  }
  return null;
}

/** Re-measures metrics of finished tasks whose wait is over. */
export async function runFeedbackLoop(now = new Date()): Promise<number> {
  const due = await AutomationLinkModel.find({
    remeasureAt: { $ne: null, $lte: now },
    result: null,
  }).limit(200);
  let measured = 0;
  for (const link of due) {
    const settings = await automationSettings(
      link.workspaceId
        ? String(link.workspaceId)
        : await agentService.defaultWorkspaceId(String(link.userId)),
    );
    const again = link.metric
      ? await measureAgain(
          link,
          Math.max(5, Math.floor(settings.minSample / 2)),
        )
      : null;
    if (!again || !link.metric) {
      // Not enough new data yet: look again in a week, four times at most.
      link.remeasureTries += 1;
      link.remeasureAt =
        link.remeasureTries >= 4 ? null : new Date(now.getTime() + 7 * DAY);
      if (!link.remeasureAt) link.state = "cleared";
      await link.save();
      continue;
    }
    const outcome = outcomeOf(
      link.metric.value,
      again.value,
      link.metric.lowerIsBetter,
    );
    link.result = {
      value: again.value,
      measuredAt: now,
      outcome,
      sample: again.sample,
    };
    link.remeasureAt = null;
    link.state = "cleared";
    link.markModified("result");
    await link.save();
    const days = Math.max(
      1,
      Math.round((now.getTime() - (link.closedAt ?? now).getTime()) / DAY),
    );
    const resultLine = `Result after ${days} days: ${link.metric.name} went from ${formatMetric(link.metric.unit, link.metric.value)} to ${formatMetric(link.metric.unit, again.value)} (${outcome}).`;
    const task = await TaskModel.findById(link.taskId).select("note");
    if (task) {
      task.note = [task.note, resultLine].filter(Boolean).join("\n");
      await task.save().catch(() => undefined);
    }
    await logGovernanceEvent({
      workspaceId: link.workspaceId
        ? String(link.workspaceId)
        : await agentService.defaultWorkspaceId(String(link.userId)),
      type: "auto_task_result",
      actor: "system",
      title: `Result: ${link.title}`,
      detail: `${link.metric.name} went from ${formatMetric(link.metric.unit, link.metric.value)} to ${formatMetric(link.metric.unit, again.value)} after ${days} days (${outcome}).`,
      link: taskLink(
        String(link.taskId),
        link.projectId ? String(link.projectId) : null,
      ),
    });
    measured += 1;
  }
  return measured;
}

/* ------------------------------------------------------------------ */
/* Sweeps and hooks                                                     */
/* ------------------------------------------------------------------ */

export async function syncWorkspace(workspaceId: string) {
  const settings = await automationSettings(workspaceId);
  const rules = WORKSPACE_RULES.filter((r) => ruleOn(settings, r));
  // Rules that are off produce no findings but their open tasks are left alone.
  const counts = await reconcile(
    { workspaceId },
    rules,
    await workspaceFindings(workspaceId, settings),
    settings,
  );
  await syncProjectGovernance(workspaceId);
  return counts;
}

export async function syncTenant(userId: string) {
  const workspaceId = await agentService.defaultWorkspaceId(userId);
  const settings = await automationSettings(workspaceId);
  const rules = TENANT_RULES.filter((r) => ruleOn(settings, r));
  return reconcile(
    { workspaceId, userId },
    rules,
    await tenantFindings(userId, settings),
    settings,
  );
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Debounced sync after something changed (an incident opened, an agent got a key, a control passed). */
export function scheduleWorkspaceSync(
  workspaceId: string | null | undefined,
  delayMs = 2000,
): void {
  if (!workspaceId || pending.has(workspaceId)) return;
  pending.set(
    workspaceId,
    setTimeout(() => {
      pending.delete(workspaceId);
      void syncWorkspace(workspaceId).catch((error) =>
        logger.warn("Automation sync failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }, delayMs).unref(),
  );
}

/** Every workspace and every integration owner. Governance rules are cheap; telemetry rules read more. */
export async function runAutomation(options: { telemetry: boolean }) {
  const totals = {
    workspaces: 0,
    tenants: 0,
    opened: 0,
    closed: 0,
    measured: 0,
    purged: 0,
  };
  const workspaces = await WorkspaceModel.find({}).select("_id").lean();
  for (const ws of workspaces) {
    try {
      const c = await syncWorkspace(String(ws._id));
      totals.workspaces += 1;
      totals.opened += c.opened;
      totals.closed += c.closed;
    } catch (error) {
      logger.warn("Automation sync failed", {
        workspaceId: String(ws._id),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (options.telemetry) {
    const tenants = (await SdkIntegrationModel.distinct("tenantId", {
      status: { $ne: "revoked" },
    })) as string[];
    for (const tenant of tenants) {
      if (!Types.ObjectId.isValid(tenant)) continue;
      try {
        const c = await syncTenant(tenant);
        totals.tenants += 1;
        totals.opened += c.opened;
        totals.closed += c.closed;
        totals.purged += await purgeOldEvents(tenant);
      } catch (error) {
        logger.warn("Telemetry automation failed", {
          tenant,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    totals.measured = await runFeedbackLoop();
  }
  return totals;
}

/** Deletes end-user events older than the workspace's retention setting (0 keeps everything). */
export async function purgeOldEvents(userId: string): Promise<number> {
  const settings = await automationSettings(
    await agentService.defaultWorkspaceId(userId),
  );
  if (!settings.eventRetentionDays) return 0;
  const ids = (
    await SdkIntegrationModel.find({ tenantId: userId }).select("_id").lean()
  ).map((i) => String(i._id));
  if (!ids.length) return 0;
  const result = await AnalyticsLogModel.deleteMany({
    sdkIntegrationId: { $in: ids },
    createdAt: {
      $lt: new Date(Date.now() - settings.eventRetentionDays * DAY),
    },
  });
  return result.deletedCount ?? 0;
}

/* --------------------------- New projects --------------------------- */

/** A governance checklist for a new project. Done → the project is "Governance ready". */
export async function onProjectCreated(
  project: { id: string; name: string; workspaceId?: string | null },
  userId: string,
): Promise<void> {
  const workspaceId = project.workspaceId
    ? String(project.workspaceId)
    : await agentService.defaultWorkspaceId(userId);
  const settings = await automationSettings(workspaceId);
  if (!ruleOn(settings, "project_governance")) return;
  const key = `project_governance:${project.id}`;
  if (await AutomationLinkModel.exists({ key })) return;
  await openTask(
    {
      rule: "project_governance",
      key,
      title: `Set up governance for ${project.name}`,
      description: `Before agents work in ${project.name}: label its data, check which agents can change it, run a compliance check and name who owns governance for it. When every step is done the project is marked "Governance ready".`,
      priority: "MEDIUM",
      assigneeUserId: userId,
      projectId: project.id,
      link: `/projects/${project.id}`,
      subtasks: GOVERNANCE_CHECKLIST.map((title) => ({ title })),
      context: { projectId: project.id },
    },
    workspaceId,
    settings,
  );
}

/** Ticks "Review the data label" once the project has a label, and notices finished checklists. */
async function syncProjectGovernance(workspaceId: string): Promise<void> {
  const links = await AutomationLinkModel.find({
    workspaceId: oid(workspaceId),
    rule: "project_governance",
    state: "open",
  });
  for (const link of links) {
    const project = await ProjectModel.findById(link.context?.projectId)
      .select("classification")
      .lean();
    const task = await TaskModel.findById(link.taskId)
      .select("status completedAt")
      .lean();
    if (!project || !task) {
      link.state = "cleared";
      await link.save();
      continue;
    }
    if (task.status === "DONE") {
      link.state = "done";
      link.closedBy = "person";
      link.closedAt = task.completedAt ?? new Date();
      await link.save();
      await logGovernanceEvent({
        workspaceId,
        type: "project_governance_ready",
        actor: "person",
        title: `Project is governance ready`,
        detail: link.title,
        link: `/projects/${link.context?.projectId}`,
      });
      continue;
    }
    if ((project as { classification?: string | null }).classification)
      await syncSubtasks(link, [
        { title: GOVERNANCE_CHECKLIST[0], done: true },
      ]);
  }
}

/** Projects whose governance checklist is finished. */
export async function governanceReady(
  projectIds: string[],
): Promise<Record<string, "ready" | "pending">> {
  const links = await AutomationLinkModel.find({
    rule: "project_governance",
    key: { $in: projectIds.map((id) => `project_governance:${id}`) },
  })
    .select("key state")
    .lean();
  return Object.fromEntries(
    links.map((l) => [
      l.key.split(":")[1],
      l.state === "done" ? "ready" : l.state === "open" ? "pending" : "ready",
    ]),
  ) as Record<string, "ready" | "pending">;
}
