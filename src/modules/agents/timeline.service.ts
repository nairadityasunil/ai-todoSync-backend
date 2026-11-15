import { Types } from "mongoose";

import AnalyticsEventRegistryModel from "../analytics/models/analytics-event-registry.model.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import ActivityLogModel from "../audit/models/activity-log.model.js";
import { GuideExposureModel } from "../engagement/model.js";
import GuideModel from "../guides/model.js";
import ProjectModel from "../project/models/project.model.js";
import projectService from "../project/services/project.service.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";
import {
  AgentActivityModel,
  AgentAlertModel,
  AgentApprovalModel,
  AgentIncidentModel,
  AgentModel,
  GovernanceEventModel,
} from "./model.js";

import { mergeTimeline, type TimelineItem } from "./timeline-merge.js";

export type { TimelineItem };

export type TimelineKind = TimelineItem["kind"];

const ALERT_LABELS: Record<string, string> = {
  unregistered_agent: "Shadow AI detected",
  threat: "Threat detected",
  dlp: "Data loss prevention",
  compliance_drift: "Compliance drift",
  critical_risk: "Critical risk",
  volume_spike: "Unusual volume",
  off_hours: "Unusual timing",
  new_tool: "New action",
  permission_errors: "Permission errors",
  bulk_destructive: "Bulk deletes",
  policy_block: "Blocked by policy",
  rate_limited: "Rate limited",
};

export interface TimelineQuery {
  userId: string;
  workspaceId: string;
  /** Workspaces where the caller is an admin (sees every agent there). */
  adminWorkspaceIds: Types.ObjectId[];
  kinds: TimelineKind[];
  projectId?: string;
  personId?: string;
  agentId?: string;
  since?: Date;
  until?: Date;
  limit: number;
  /** Agent actions of these risk tiers only (low, medium, high, critical). */
  tiers?: string[];
  /** Agent actions decided by a policy, the system or a person. */
  decidedBy?: "policy" | "system" | "person";
  /** Agent actions with this outcome (allowed, blocked, pending_approval). */
  outcome?: string;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const refName = (ref: unknown, fallback: string) =>
  ref && typeof ref === "object" && "name" in ref && ref.name
    ? String((ref as { name: unknown }).name)
    : fallback;
const refId = (ref: unknown) =>
  ref && typeof ref === "object" && "_id" in ref
    ? String((ref as { _id: unknown })._id)
    : ref
      ? String(ref)
      : undefined;

/**
 * Task changes, agent actions, approvals and end-user events in one list. Each source is limited to what the
 * caller can already see elsewhere: projects they belong to, agents they own or administer, and SDK
 * integrations they own.
 */
export async function buildTimeline(q: TimelineQuery): Promise<TimelineItem[]> {
  const created =
    q.since || q.until
      ? {
          createdAt: {
            ...(q.since ? { $gte: q.since } : {}),
            ...(q.until ? { $lte: q.until } : {}),
          },
        }
      : {};
  const workspace = new Types.ObjectId(q.workspaceId);
  const wants = (kind: TimelineKind) => q.kinds.includes(kind);
  // A person filter or agent filter narrows to the sources that have that actor.
  const onlyAgentSources = Boolean(q.agentId);

  const memberProjectIds = (await projectService.fetchProjects(q.userId)).map(
    (project) => project.id,
  );
  const workspaceProjects = await ProjectModel.find({
    _id: { $in: memberProjectIds },
    workspaceId: workspace,
  })
    .select("_id name")
    .lean();
  const projectName = new Map(
    workspaceProjects.map((p) => [String(p._id), String(p.name)]),
  );
  let projectIds = [...projectName.keys()];
  if (q.projectId) projectIds = projectIds.filter((id) => id === q.projectId);

  const visibleAgents = {
    $or: [
      { userId: new Types.ObjectId(q.userId) },
      { workspaceId: { $in: q.adminWorkspaceIds } },
    ],
  };
  const agentFilter =
    q.agentId && Types.ObjectId.isValid(q.agentId)
      ? { agentId: new Types.ObjectId(q.agentId) }
      : {};
  const projectFilter =
    q.projectId && Types.ObjectId.isValid(q.projectId)
      ? { projectId: new Types.ObjectId(q.projectId) }
      : {};

  const [work, agentRows, approvals, events] = await Promise.all([
    wants("work") &&
    projectIds.length &&
    !q.tiers?.length &&
    !q.decidedBy &&
    !q.outcome
      ? ActivityLogModel.find({
          projectId: { $in: projectIds },
          ...(q.personId ? { userId: q.personId } : {}),
          ...(q.agentId ? { "metadata.agent.id": q.agentId } : {}),
          ...created,
        })
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .lean()
      : [],
    wants("agent") && !q.personId
      ? AgentActivityModel.find({
          workspaceId: workspace,
          ...visibleAgents,
          ...agentFilter,
          ...projectFilter,
          ...created,
          ...(q.tiers?.length ? { tier: { $in: q.tiers } } : {}),
          ...(q.decidedBy ? { decidedBy: q.decidedBy } : {}),
          ...(q.outcome ? { outcome: q.outcome } : {}),
        })
          .select("-undo -input")
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .populate("agentId", "name")
          .lean()
      : [],
    wants("approval") &&
    !q.personId &&
    q.decidedBy !== "policy" &&
    (!q.outcome || q.outcome === "pending_approval")
      ? AgentApprovalModel.find({
          workspaceId: workspace,
          ...(q.tiers?.length ? { tier: { $in: q.tiers } } : {}),
          ...(q.outcome ? { status: "pending" } : {}),
          ...(q.decidedBy
            ? {
                status: { $ne: "pending" },
                decidedBySystem:
                  q.decidedBy === "system" ? true : { $ne: true },
              }
            : {}),
          $or: [
            { ownerUserId: new Types.ObjectId(q.userId) },
            { workspaceId: { $in: q.adminWorkspaceIds } },
          ],
          ...agentFilter,
          ...projectFilter,
          ...created,
        })
          .select("-inputPreview -result")
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .populate("agentId", "name")
          .populate("decidedBy", "name email")
          .lean()
      : [],
    wants("event") && !onlyAgentSources && !q.personId && !q.projectId
      ? (async () => {
          const integrations = await SdkIntegrationModel.find({
            tenantId: q.userId,
          })
            .select("_id name")
            .lean();
          if (!integrations.length) return [];
          const ids = integrations.map((i) => String(i._id));
          const integrationName = new Map(
            integrations.map((i) => [String(i._id), String(i.name)]),
          );
          const logs = await AnalyticsLogModel.find({
            sdkIntegrationId: { $in: ids },
            ...created,
          })
            .select(
              "_id createdAt eventRef eventName sdkIntegrationId userIdentifier",
            )
            .sort({ createdAt: -1 })
            .limit(q.limit)
            .lean();
          const refs = [
            ...new Set(
              logs
                .map((l) => l.eventRef)
                .filter((r): r is string => Boolean(r)),
            ),
          ];
          const registries = refs.length
            ? await AnalyticsEventRegistryModel.find({ _id: { $in: refs } })
                .select("_id eventName")
                .lean()
            : [];
          const nameByRef = new Map(
            registries.map((r) => [String(r._id), String(r.eventName)]),
          );
          return logs.map((log) => ({
            log,
            integration: integrationName.get(log.sdkIntegrationId) ?? "App",
            nameByRef,
          }));
        })()
      : [],
  ]);

  // Guide activity of the caller's own integrations: who finished and who stopped where.
  const guideRows =
    wants("guide") &&
    !onlyAgentSources &&
    !q.personId &&
    !q.projectId &&
    !q.tiers?.length &&
    !q.decidedBy &&
    !q.outcome
      ? await (async () => {
          const integrations = await SdkIntegrationModel.find({
            tenantId: q.userId,
          })
            .select("_id")
            .lean();
          if (!integrations.length) return [];
          const updated =
            q.since || q.until
              ? {
                  updatedAt: {
                    ...(q.since ? { $gte: q.since } : {}),
                    ...(q.until ? { $lte: q.until } : {}),
                  },
                }
              : {};
          const exposures = await GuideExposureModel.find({
            sdkIntegrationId: { $in: integrations.map((i) => String(i._id)) },
            ...updated,
          })
            .select(
              "_id guideId sdkIntegrationId userId status currentStepId updatedAt",
            )
            .sort({ updatedAt: -1 })
            .limit(q.limit)
            .lean();
          const guides = await GuideModel.find({
            _id: {
              $in: [...new Set(exposures.map((e) => e.guideId))].filter((id) =>
                Types.ObjectId.isValid(id),
              ),
            },
          })
            .select("_id title steps")
            .lean();
          const guideById = new Map(guides.map((g) => [String(g._id), g]));
          return exposures.map((exposure) => ({
            exposure,
            guide: guideById.get(exposure.guideId),
          }));
        })()
      : [];

  // Detections (alerts), incidents and governance events: admins see the workspace's; others their own agents'.
  const isAdmin = q.adminWorkspaceIds.some((id) => id.equals(workspace));
  const ownAgentIds = isAdmin
    ? null
    : (
        await AgentModel.find({ ownerUserId: new Types.ObjectId(q.userId) })
          .select("_id")
          .lean()
      ).map((a) => a._id);
  const scopeToAgents = (field: string) =>
    ownAgentIds ? { [field]: { $in: ownAgentIds } } : {};
  const onlyActions = Boolean(
    q.tiers?.length || q.decidedBy || q.outcome || q.personId,
  );
  const [alerts, incidents, govEvents] = await Promise.all([
    wants("detection") && !onlyActions && !q.projectId
      ? AgentAlertModel.find({
          workspaceId: workspace,
          ...scopeToAgents("agentId"),
          ...(q.agentId ? { agentId: new Types.ObjectId(q.agentId) } : {}),
          ...created,
        })
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .populate("agentId", "name")
          .lean()
      : [],
    wants("incident") && !onlyActions && !q.projectId
      ? AgentIncidentModel.find({
          workspaceId: workspace,
          ...scopeToAgents("agentIds"),
          ...(q.agentId ? { agentIds: new Types.ObjectId(q.agentId) } : {}),
          ...created,
        })
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .lean()
      : [],
    wants("system") &&
    !q.projectId &&
    !q.tiers?.length &&
    !q.outcome &&
    (!q.decidedBy || q.decidedBy !== "policy")
      ? GovernanceEventModel.find({
          workspaceId: workspace,
          ...scopeToAgents("agentId"),
          ...(q.agentId ? { agentId: new Types.ObjectId(q.agentId) } : {}),
          ...(q.decidedBy ? { actor: q.decidedBy } : {}),
          ...(q.personId ? { userId: new Types.ObjectId(q.personId) } : {}),
          ...created,
        })
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .populate("agentId", "name")
          .populate("userId", "name email")
          .lean()
      : [],
  ]);

  const items: TimelineItem[][] = [
    work.map((row) => {
      const agent = (
        row.metadata as { agent?: { id?: string; name?: string } } | undefined
      )?.agent;
      const project = String(row.projectId);
      const isTask = row.entityType === "task" || row.entityType === "subtask";
      return {
        id: `work:${row._id}`,
        kind: "work" as const,
        at: iso(row.createdAt),
        title: row.description,
        detail: projectName.get(project),
        actor: agent
          ? {
              type: "agent" as const,
              id: agent.id,
              name: `${agent.name ?? "Agent"} for ${row.userName}`,
            }
          : { type: "person" as const, id: row.userId, name: row.userName },
        projectId: project,
        link:
          isTask && row.entityType === "task"
            ? `/projects/${project}?task=${row.entityId}`
            : `/projects/${project}`,
      };
    }),
    agentRows.map((row) => ({
      id: `agent:${row._id}`,
      kind: "agent" as const,
      at: iso(row.createdAt),
      title: `${row.action} · ${row.outcome === "pending_approval" ? "held for approval" : row.outcome}`,
      detail:
        [
          row.decidedBy === "system"
            ? `System decided${row.rule ? `: ${row.rule}` : ""}`
            : row.decidedBy === "person"
              ? (row.rule ?? "Decided by a person")
              : row.policyName
                ? `policy “${row.policyName}”`
                : null,
          (row.dlp ?? []).length
            ? `DLP: ${(row.dlp ?? []).map((f: { label: string }) => f.label.toLowerCase()).join(", ")}`
            : null,
          row.projectId ? projectName.get(String(row.projectId)) : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      decidedBy:
        (row.decidedBy as TimelineItem["decidedBy"]) ??
        (row.policyName ? "policy" : null),
      outcome: row.outcome,
      tier: row.tier ?? null,
      actor: {
        type: "agent" as const,
        id: refId(row.agentId),
        name: refName(row.agentId, "Agent"),
      },
      projectId: row.projectId ? String(row.projectId) : null,
      link: `/agents/inventory?agent=${refId(row.agentId) ?? ""}`,
    })),
    approvals.map((row) => ({
      id: `approval:${row._id}`,
      kind: "approval" as const,
      at: iso(row.decidedAt ?? row.createdAt),
      title:
        row.status === "pending"
          ? `Approval needed: ${row.action}`
          : `${row.action} ${row.status}${row.decidedBy ? ` by ${refName(row.decidedBy, "someone")}` : ""}`,
      detail:
        [
          row.policyName ? `policy “${row.policyName}”` : null,
          row.recommendation
            ? `recommended: ${row.recommendation.decision}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      actor: {
        type: "agent" as const,
        id: refId(row.agentId),
        name: refName(row.agentId, "Agent"),
      },
      projectId: row.projectId ? String(row.projectId) : null,
      link: "/agents/approvals",
      decidedBy:
        row.status === "pending"
          ? null
          : row.decidedBySystem
            ? ("system" as const)
            : ("person" as const),
      tier: row.tier ?? null,
    })),
    alerts.map((row) => ({
      id: `detection:${row._id}`,
      kind: "detection" as const,
      at: iso(row.createdAt),
      title: row.title,
      detail: [ALERT_LABELS[row.type] ?? row.type, row.detail]
        .filter(Boolean)
        .join(" · "),
      actor: row.agentId
        ? {
            type: "agent" as const,
            id: refId(row.agentId),
            name: refName(row.agentId, "Agent"),
          }
        : { type: "person" as const, name: "System" },
      link: row.agentId
        ? `/agents/inventory?agent=${refId(row.agentId)}`
        : "/agents",
      decidedBy: "system" as const,
      severity: row.severity,
    })),
    incidents.map((row) => ({
      id: `incident:${row._id}`,
      kind: "incident" as const,
      at: iso((row as unknown as { createdAt: Date }).createdAt),
      title: `Incident: ${row.title}`,
      detail: `${row.status}${row.resolution ? ` (${row.resolution.replace("_", " ")})` : ""} · ${row.summary}`,
      actor: { type: "person" as const, name: "System" },
      link: `/agents/incidents?incident=${row._id}`,
      decidedBy: "system" as const,
      severity: row.severity,
    })),
    govEvents.map((row) => ({
      id: `system:${row._id}`,
      kind: "system" as const,
      at: iso(row.createdAt),
      title: row.title,
      detail: [row.actor === "system" ? "System decided" : "Person", row.detail]
        .filter(Boolean)
        .join(" · "),
      actor:
        row.actor === "system"
          ? { type: "person" as const, name: "System" }
          : {
              type: "person" as const,
              id: refId(row.userId),
              name: refName(row.userId, "Someone"),
            },
      link: row.link
        ? String(row.link)
        : row.incidentId
          ? `/agents/incidents?incident=${row.incidentId}`
          : row.agentId
            ? `/agents/inventory?agent=${refId(row.agentId)}`
            : "/agents",
      decidedBy:
        row.actor === "system" ? ("system" as const) : ("person" as const),
    })),
    guideRows.map(({ exposure, guide }) => {
      const steps = guide?.steps ?? [];
      const index = steps.findIndex(
        (step) => step.id === exposure.currentStepId,
      );
      const where =
        index >= 0
          ? `step ${index + 1} of ${steps.length} (“${steps[index].title}”)`
          : null;
      const name = guide?.title ?? "Guide";
      const title =
        exposure.status === "completed"
          ? `${name} · completed`
          : exposure.status === "dismissed" || exposure.status === "abandoned"
            ? `${name} · left${where ? ` at ${where}` : ""}`
            : `${name} · ${where ? `at ${where}` : "shown"}`;
      return {
        id: `guide:${exposure._id}`,
        kind: "guide" as const,
        at: iso(exposure.updatedAt ?? new Date()),
        title,
        detail:
          exposure.status === "completed"
            ? undefined
            : where &&
                exposure.status !== "dismissed" &&
                exposure.status !== "abandoned"
              ? "No further steps yet"
              : undefined,
        actor: {
          type: "end_user" as const,
          name: exposure.userId || "Anonymous user",
        },
        link: `/sdk-integrations/${exposure.sdkIntegrationId}/guides?analytics=${exposure.guideId}`,
      };
    }),
    events.map(({ log, integration, nameByRef }) => ({
      id: `event:${log._id}`,
      kind: "event" as const,
      at: iso(log.createdAt),
      title: log.eventName ?? nameByRef.get(String(log.eventRef)) ?? "event",
      detail: integration,
      actor: {
        type: "end_user" as const,
        name: log.userIdentifier || "Anonymous user",
      },
      link: `/sdk-integrations/${log.sdkIntegrationId}/events`,
    })),
  ];
  return mergeTimeline(items, q.limit);
}

/** Agents the caller can filter the timeline by. */
export async function timelineAgents(
  q: Pick<TimelineQuery, "userId" | "workspaceId" | "adminWorkspaceIds">,
) {
  const agents = await AgentModel.find({
    workspaceId: new Types.ObjectId(q.workspaceId),
    $or: [
      { ownerUserId: new Types.ObjectId(q.userId) },
      { workspaceId: { $in: q.adminWorkspaceIds } },
    ],
  })
    .select("_id name")
    .sort({ name: 1 })
    .limit(200)
    .lean();
  return agents.map((agent) => ({
    id: String(agent._id),
    name: String(agent.name),
  }));
}
