import type { Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import agentService from "./agent.service.js";
import approvalService from "./approval.service.js";
import { adminWorkspaces, param, requireWorkspace, str, userIdOf } from "./http.js";
import { logGovernanceEvent } from "./hybrid.service.js";
import {
  AgentActivityModel,
  AgentAlertModel,
  AgentIncidentModel,
  AgentModel,
  GovernanceEventModel,
  type IAgentIncidentDocument,
} from "./model.js";
import webhookService from "./webhooks.service.js";

/** An incident the caller may see and act on: workspace admins, or the owner of every agent involved. */
async function loadIncident(req: AuthenticatedRequest, userId: string): Promise<{ incident: IAgentIncidentDocument; isAdmin: boolean }> {
  const workspaceId = await requireWorkspace(req, userId);
  const incident = await AgentIncidentModel.findOne({ _id: param(req, "incidentId"), workspaceId });
  if (!incident) throw new AppError(404, "Incident not found", "NOT_FOUND");
  const isAdmin = (await adminWorkspaces(userId)).some((ws) => ws.equals(workspaceId));
  if (!isAdmin) {
    const owned = await AgentModel.countDocuments({ _id: { $in: incident.agentIds }, ownerUserId: new Types.ObjectId(userId) });
    if (owned !== incident.agentIds.length) throw new AppError(404, "Incident not found", "NOT_FOUND");
  }
  return { incident, isAdmin };
}

const serialize = (incident: IAgentIncidentDocument, agents: Array<{ _id: unknown; name: string; status: string; kind: string; riskLevel?: string }>) => ({
  id: incident._id.toString(),
  title: incident.title,
  severity: incident.severity,
  trigger: incident.trigger,
  status: incident.status,
  action: incident.action ?? null,
  summary: incident.summary,
  agents: agents.map((a) => ({ id: String(a._id), name: a.name, status: a.status, kind: a.kind, riskLevel: a.riskLevel ?? null })),
  timeline: incident.timeline,
  suggestions: incident.suggestions,
  windowFrom: incident.windowFrom,
  windowTo: incident.windowTo ?? null,
  resolution: incident.resolution ?? null,
  resolvedAt: incident.resolvedAt ?? null,
  createdAt: (incident as unknown as { createdAt: Date }).createdAt,
});

async function agentsOf(incident: IAgentIncidentDocument) {
  return AgentModel.find({ _id: { $in: incident.agentIds } }).select("name status kind riskLevel ownerUserId").lean();
}

class IncidentController {
  public list = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const isAdmin = (await adminWorkspaces(userId)).some((ws) => ws.equals(workspaceId));
    const filter: Record<string, unknown> = { workspaceId };
    const status = str(req.query.status);
    if (status === "open") filter.status = { $ne: "resolved" };
    else if (status) filter.status = status;
    if (!isAdmin) {
      const mine = await AgentModel.find({ ownerUserId: new Types.ObjectId(userId) }).select("_id").lean();
      filter.agentIds = { $in: mine.map((a) => a._id) };
    }
    const incidents = await AgentIncidentModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 50, 200));
    const agentIds = [...new Set(incidents.flatMap((i) => i.agentIds.map(String)))];
    const agents = await AgentModel.find({ _id: { $in: agentIds } }).select("name status kind riskLevel").lean();
    const byId = new Map(agents.map((a) => [String(a._id), a]));
    res.json({
      success: true,
      data: incidents.map((i) => serialize(i, i.agentIds.map((id) => byId.get(String(id))).filter((a): a is NonNullable<typeof a> => Boolean(a)))),
    });
  };

  /** The incident with the activity of its agents in the incident window, and related agents (same owners). */
  public get = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { incident } = await loadIncident(req, userId);
    const agents = await agentsOf(incident);
    const to = incident.windowTo ?? new Date();
    const [activity, alerts, related] = await Promise.all([
      AgentActivityModel.find({ agentId: { $in: incident.agentIds }, createdAt: { $gte: incident.windowFrom, $lte: to } })
        .select("-undo")
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
      AgentAlertModel.find({ agentId: { $in: incident.agentIds }, createdAt: { $gte: incident.windowFrom, $lte: to } }).sort({ createdAt: -1 }).limit(100).lean(),
      AgentModel.find({
        _id: { $nin: incident.agentIds },
        ownerUserId: { $in: agents.map((a) => a.ownerUserId) },
        status: { $ne: "revoked" },
      })
        .select("name status kind riskLevel")
        .limit(20)
        .lean(),
    ]);
    res.json({
      success: true,
      data: {
        ...serialize(incident, agents),
        activity: activity.map((row) => ({ ...row, id: String(row._id) })),
        alerts: alerts.map((row) => ({ ...row, id: String(row._id) })),
        relatedAgents: related.map((a) => ({ id: String(a._id), name: a.name, status: a.status, kind: a.kind, riskLevel: a.riskLevel ?? null })),
      },
    });
  };

  private async act(
    req: AuthenticatedRequest,
    res: Response,
    action: "resume" | "revoke" | "resolve" | "expand",
  ) {
    const userId = userIdOf(req);
    const { incident } = await loadIncident(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = str(body.note)?.slice(0, 500) ?? null;
    const agents = await AgentModel.find({ _id: { $in: incident.agentIds } });
    const now = new Date();
    if (action === "resume") {
      // False positive: bring the agents back. Optionally the next change needs a person.
      const requireReapproval = body.requireReapproval === true;
      for (const agent of agents) {
        if (agent.status === "revoked") continue;
        agent.status = "active";
        agent.suspendedBySystem = false;
        agent.statusReason = null;
        agent.reapprovalRequired = requireReapproval;
        await agent.save();
        agentService.invalidate(agent._id.toString());
      }
      incident.timeline.push({ at: now, actor: "person", userId: new Types.ObjectId(userId), action: "resumed", detail: `Agents resumed${requireReapproval ? "; their next change needs a person's approval" : ""}.${note ? ` ${note}` : ""}` });
      incident.status = "resolved";
      incident.resolution = "false_positive";
    } else if (action === "revoke") {
      for (const agent of agents) {
        agent.status = "revoked";
        agent.suspendedBySystem = false;
        agent.statusReason = `Revoked after incident: ${incident.title}`.slice(0, 300);
        if (agent.kind === "api_key") {
          agent.keyHash = null;
          agent.previousKeyHash = null;
          agent.pendingKeyCiphertext = null;
        }
        await agent.save();
        agentService.invalidate(agent._id.toString());
      }
      await approvalService.expireForAgents(agents.map((a) => a._id));
      incident.timeline.push({ at: now, actor: "person", userId: new Types.ObjectId(userId), action: "revoked", detail: `Agents revoked permanently.${note ? ` ${note}` : ""}` });
      incident.status = "resolved";
      incident.resolution = "revoked";
    } else if (action === "expand") {
      // Bring related agents (same owners) into the incident.
      const ids = Array.isArray(body.agentIds) ? body.agentIds.filter((id): id is string => typeof id === "string" && Types.ObjectId.isValid(id)) : [];
      const related = await AgentModel.find({ _id: { $in: ids }, ownerUserId: { $in: agents.map((a) => a.ownerUserId) } }).select("_id name").lean();
      const existing = new Set(incident.agentIds.map(String));
      for (const agent of related) if (!existing.has(String(agent._id))) incident.agentIds.push(agent._id);
      incident.timeline.push({ at: now, actor: "person", userId: new Types.ObjectId(userId), action: "expanded", detail: `Added ${related.map((a) => a.name).join(", ") || "no agents"} to the investigation.` });
    } else {
      incident.timeline.push({ at: now, actor: "person", userId: new Types.ObjectId(userId), action: "resolved", detail: note ?? "Resolved." });
      incident.status = "resolved";
      incident.resolution = str(body.resolution)?.slice(0, 60) ?? "resolved";
    }
    if (incident.status === "resolved") {
      incident.resolvedAt = now;
      incident.resolvedBy = new Types.ObjectId(userId);
      incident.windowTo = incident.windowTo ?? now;
    }
    await incident.save();
    await logGovernanceEvent({
      workspaceId: incident.workspaceId ? String(incident.workspaceId) : null,
      type: `incident_${action}`,
      actor: "person",
      userId,
      incidentId: incident._id.toString(),
      agentId: agents[0]?._id.toString() ?? null,
      title: `Incident ${action === "expand" ? "expanded" : action === "resume" ? "closed as a false positive" : action === "revoke" ? "closed: agent revoked" : "resolved"}: ${incident.title}`,
      detail: note ?? "",
    });
    res.json({ success: true, data: serialize(incident, await agentsOf(incident)) });
  }

  public resume = (req: AuthenticatedRequest, res: Response) => this.act(req, res, "resume");
  public revoke = (req: AuthenticatedRequest, res: Response) => this.act(req, res, "revoke");
  public resolve = (req: AuthenticatedRequest, res: Response) => this.act(req, res, "resolve");
  public expand = (req: AuthenticatedRequest, res: Response) => this.act(req, res, "expand");

  /** Sends the incident to the workspace's webhooks (Slack, SIEM) again, on demand. */
  public notify = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { incident } = await loadIncident(req, userId);
    webhookService.emit({
      type: "incident.opened",
      workspaceId: incident.workspaceId ? String(incident.workspaceId) : null,
      severity: incident.severity,
      summary: `Incident (${incident.status}): ${incident.title}`,
      data: { incidentId: incident._id.toString(), trigger: incident.trigger, status: incident.status, summary: incident.summary },
    });
    incident.timeline.push({ at: new Date(), actor: "person", userId: new Types.ObjectId(userId), action: "notified", detail: "Sent to the workspace's webhooks." });
    await incident.save();
    res.json({ success: true, data: { notified: true } });
  };

  /** Evidence for one incident: the record, its agents, activity, alerts and governance events in the window. */
  public evidence = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { incident } = await loadIncident(req, userId);
    const to = incident.windowTo ?? new Date();
    const [agents, activity, alerts, events] = await Promise.all([
      agentsOf(incident),
      AgentActivityModel.find({ agentId: { $in: incident.agentIds }, createdAt: { $gte: incident.windowFrom, $lte: to } }).select("-undo").sort({ createdAt: 1 }).lean(),
      AgentAlertModel.find({ agentId: { $in: incident.agentIds }, createdAt: { $gte: incident.windowFrom, $lte: to } }).sort({ createdAt: 1 }).lean(),
      GovernanceEventModel.find({ incidentId: incident._id }).sort({ createdAt: 1 }).lean(),
    ]);
    incident.timeline.push({ at: new Date(), actor: "person", userId: new Types.ObjectId(userId), action: "exported", detail: "Evidence exported." });
    await incident.save();
    res.setHeader("Content-Disposition", `attachment; filename="incident-${incident._id}.json"`);
    res.json({ generatedAt: new Date(), incident: serialize(incident, agents), activity, alerts, governanceEvents: events });
  };
}

export default new IncidentController();
