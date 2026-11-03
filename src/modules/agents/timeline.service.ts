import { Types } from "mongoose";

import AnalyticsEventRegistryModel from "../analytics/models/analytics-event-registry.model.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import ActivityLogModel from "../audit/models/activity-log.model.js";
import ProjectModel from "../project/models/project.model.js";
import projectService from "../project/services/project.service.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";
import { AgentActivityModel, AgentApprovalModel, AgentModel } from "./model.js";

import { mergeTimeline, type TimelineItem } from "./timeline-merge.js";

export type { TimelineItem };

export type TimelineKind = TimelineItem["kind"];

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
  const agentFilter = q.agentId && Types.ObjectId.isValid(q.agentId)
    ? { agentId: new Types.ObjectId(q.agentId) }
    : {};
  const projectFilter = q.projectId && Types.ObjectId.isValid(q.projectId)
    ? { projectId: new Types.ObjectId(q.projectId) }
    : {};

  const [work, agentRows, approvals, events] = await Promise.all([
    wants("work") && projectIds.length
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
        })
          .select("-undo -input")
          .sort({ createdAt: -1 })
          .limit(q.limit)
          .populate("agentId", "name")
          .lean()
      : [],
    wants("approval") && !q.personId
      ? AgentApprovalModel.find({
          workspaceId: workspace,
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
          const integrations = await SdkIntegrationModel.find({ tenantId: q.userId })
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
            .select("_id createdAt eventRef eventName sdkIntegrationId userIdentifier")
            .sort({ createdAt: -1 })
            .limit(q.limit)
            .lean();
          const refs = [...new Set(logs.map((l) => l.eventRef).filter((r): r is string => Boolean(r)))];
          const registries = refs.length
            ? await AnalyticsEventRegistryModel.find({ _id: { $in: refs } })
                .select("_id eventName")
                .lean()
            : [];
          const nameByRef = new Map(registries.map((r) => [String(r._id), String(r.eventName)]));
          return logs.map((log) => ({ log, integration: integrationName.get(log.sdkIntegrationId) ?? "App", nameByRef }));
        })()
      : [],
  ]);

  const items: TimelineItem[][] = [
    work.map((row) => {
      const agent = (row.metadata as { agent?: { id?: string; name?: string } } | undefined)?.agent;
      const project = String(row.projectId);
      const isTask = row.entityType === "task" || row.entityType === "subtask";
      return {
        id: `work:${row._id}`,
        kind: "work" as const,
        at: iso(row.createdAt),
        title: row.description,
        detail: projectName.get(project),
        actor: agent
          ? { type: "agent" as const, id: agent.id, name: `${agent.name ?? "Agent"} for ${row.userName}` }
          : { type: "person" as const, id: row.userId, name: row.userName },
        projectId: project,
        link: isTask && row.entityType === "task"
          ? `/projects/${project}?task=${row.entityId}`
          : `/projects/${project}`,
      };
    }),
    agentRows.map((row) => ({
      id: `agent:${row._id}`,
      kind: "agent" as const,
      at: iso(row.createdAt),
      title: `${row.action} · ${row.outcome}`,
      detail: [row.policyName ? `policy “${row.policyName}”` : null, row.projectId ? projectName.get(String(row.projectId)) : null]
        .filter(Boolean)
        .join(" · ") || undefined,
      actor: { type: "agent" as const, id: refId(row.agentId), name: refName(row.agentId, "Agent") },
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
      detail: row.policyName ? `policy “${row.policyName}”` : undefined,
      actor: { type: "agent" as const, id: refId(row.agentId), name: refName(row.agentId, "Agent") },
      projectId: row.projectId ? String(row.projectId) : null,
      link: "/agents/approvals",
    })),
    events.map(({ log, integration, nameByRef }) => ({
      id: `event:${log._id}`,
      kind: "event" as const,
      at: iso(log.createdAt),
      title: log.eventName ?? nameByRef.get(String(log.eventRef)) ?? "event",
      detail: integration,
      actor: { type: "end_user" as const, name: log.userIdentifier || "Anonymous user" },
      link: `/sdk-integrations/${log.sdkIntegrationId}/events`,
    })),
  ];
  return mergeTimeline(items, q.limit);
}

/** Agents the caller can filter the timeline by. */
export async function timelineAgents(q: Pick<TimelineQuery, "userId" | "workspaceId" | "adminWorkspaceIds">) {
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
  return agents.map((agent) => ({ id: String(agent._id), name: String(agent.name) }));
}
