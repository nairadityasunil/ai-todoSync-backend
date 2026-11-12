import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { raiseAlert } from "./activity.service.js";
import agentService from "./agent.service.js";
import {
  incidentSuggestions,
  normalizeGovernance,
  ThreatWindows,
  type GovernanceSettings,
  type ThreatSignal,
} from "./hybrid.js";
import {
  AgentIncidentModel,
  AgentModel,
  GovernanceEventModel,
  type IAgentDocument,
  type IAgentIncidentDocument,
} from "./model.js";
import webhookService from "./webhooks.service.js";

/* ------------------------------- Settings ------------------------------- */

const settingsCache = new Map<string, { value: GovernanceSettings; at: number }>();
const SETTINGS_TTL_MS = 30_000;

export async function governanceSettings(workspaceId: string | null | undefined): Promise<GovernanceSettings> {
  if (!workspaceId) return normalizeGovernance(null);
  const hit = settingsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const workspace = await WorkspaceModel.findById(workspaceId).select("settings.governance").lean();
  const value = normalizeGovernance((workspace?.settings as { governance?: unknown } | undefined)?.governance);
  settingsCache.set(workspaceId, { value, at: Date.now() });
  return value;
}

export const invalidateGovernanceSettings = (workspaceId?: string): void => {
  if (workspaceId) settingsCache.delete(workspaceId);
  else settingsCache.clear();
};

/* -------------------------------- Events -------------------------------- */

/** Records something the system (or a person) did to governance itself; shown in the Activity timeline. */
export async function logGovernanceEvent(event: {
  workspaceId?: string | null;
  type: string;
  actor: "system" | "person";
  userId?: string | null;
  agentId?: string | null;
  incidentId?: string | null;
  title: string;
  detail?: string;
}): Promise<void> {
  try {
    await GovernanceEventModel.create({
      workspaceId: event.workspaceId ? new Types.ObjectId(event.workspaceId) : null,
      type: event.type,
      actor: event.actor,
      userId: event.userId ? new Types.ObjectId(event.userId) : null,
      agentId: event.agentId ? new Types.ObjectId(event.agentId) : null,
      incidentId: event.incidentId ? new Types.ObjectId(event.incidentId) : null,
      title: event.title.slice(0, 300),
      detail: (event.detail ?? "").slice(0, 2000),
    });
  } catch (error) {
    logger.warn("Could not record governance event", { message: error instanceof Error ? error.message : String(error) });
  }
}

/* ------------------------------ Safety nets ------------------------------ */

/** Temporary suspend by the system. The owner or any admin can resume it at once. */
export async function systemSuspend(agent: IAgentDocument, reason: string, incidentId?: string | null): Promise<boolean> {
  if (agent.status !== "active") return false;
  const updated = await AgentModel.updateOne(
    { _id: agent._id, status: "active" },
    { $set: { status: "suspended", suspendedBySystem: true, statusSetByAdmin: false, statusReason: `Suspended by the system: ${reason}`.slice(0, 300) } },
  );
  if (!updated.modifiedCount) return false;
  agent.status = "suspended";
  agent.suspendedBySystem = true;
  agentService.invalidate(agent._id.toString());
  await logGovernanceEvent({
    workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
    type: "system_suspend",
    actor: "system",
    agentId: agent._id.toString(),
    incidentId: incidentId ?? null,
    title: `System suspended ${agent.name}`,
    detail: reason,
  });
  return true;
}

/* ------------------------------- Incidents ------------------------------- */

/**
 * Opens an incident (or adds to an open one for the same agent and trigger in
 * the last hour) and, when containment is on, suspends the agents at once.
 */
export async function openIncident(input: {
  workspaceId: string | null;
  agents: IAgentDocument[];
  trigger: string;
  severity: "warning" | "critical";
  title: string;
  summary: string;
  action?: string | null;
  contain: boolean;
}): Promise<IAgentIncidentDocument | null> {
  try {
    const now = new Date();
    const agentKey = input.agents.map((a) => a._id.toString()).sort().join(",");
    const dedupeKey = `${input.trigger}:${agentKey}`;
    let incident = await AgentIncidentModel.findOne({
      dedupeKey,
      status: { $ne: "resolved" },
      createdAt: { $gte: new Date(now.getTime() - 3600_000) },
    });
    if (incident) {
      incident.timeline.push({ at: now, actor: "system", action: "signal", detail: input.summary });
    } else {
      incident = new AgentIncidentModel({
        workspaceId: input.workspaceId ? new Types.ObjectId(input.workspaceId) : null,
        title: input.title,
        severity: input.severity,
        trigger: input.trigger,
        status: "open",
        agentIds: input.agents.map((a) => a._id),
        action: input.action ?? null,
        summary: input.summary,
        timeline: [{ at: now, actor: "system", action: "opened", detail: input.summary }],
        suggestions: incidentSuggestions(input.trigger, input.action),
        // Keep the hour before the incident with it.
        windowFrom: new Date(now.getTime() - 3600_000),
        dedupeKey,
      });
    }
    if (input.contain) {
      for (const agent of input.agents) {
        if (await systemSuspend(agent, input.title, incident._id.toString())) {
          incident.timeline.push({ at: new Date(), actor: "system", action: "contained", detail: `Suspended ${agent.name} until a person reviews it.` });
          incident.status = "contained";
        }
      }
    }
    await incident.save();
    const isNew = incident.timeline.length <= 2 && incident.timeline[0]?.action === "opened";
    if (isNew) {
      await logGovernanceEvent({
        workspaceId: input.workspaceId,
        type: "incident_opened",
        actor: "system",
        agentId: input.agents[0]?._id.toString() ?? null,
        incidentId: incident._id.toString(),
        title: `Incident opened: ${input.title}`,
        detail: input.summary,
      });
      void import("./compliance.service.js").then((m) => m.scheduleComplianceCheck(input.workspaceId, "incident")).catch(() => undefined);
      webhookService.emit({
        type: "incident.opened",
        workspaceId: input.workspaceId,
        severity: input.severity,
        summary: `Incident: ${input.title}${incident.status === "contained" ? " (agent suspended)" : ""}`,
        data: { incidentId: incident._id.toString(), trigger: input.trigger, agents: input.agents.map((a) => ({ id: a._id.toString(), name: a.name })), summary: input.summary },
      });
    }
    return incident;
  } catch (error) {
    logger.warn("Could not open incident", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/* -------------------------------- Threats -------------------------------- */

export const threatWindows = new ThreatWindows();

/**
 * Acts on threat signals: alert, raise the agent's risk, and for critical ones
 * open an incident that suspends the agent (when containment is on).
 */
export async function handleThreats(agent: IAgentDocument, signals: ThreatSignal[], action?: string | null): Promise<void> {
  if (!signals.length) return;
  const workspaceId = agent.workspaceId ? String(agent.workspaceId) : null;
  const settings = await governanceSettings(workspaceId);
  if (!settings.threatDetection) return;
  for (const signal of signals) {
    await raiseAlert({
      workspaceId,
      agentId: agent._id.toString(),
      type: "threat",
      severity: signal.severity,
      title: signal.title,
      detail: signal.detail,
      dedupeKey: `threat:${signal.type}:${agent._id}:${Math.floor(Date.now() / 600_000)}`,
    }).catch(() => undefined);
    if (signal.severity === "critical") {
      await openIncident({
        workspaceId,
        agents: [agent],
        trigger: signal.type,
        severity: "critical",
        title: signal.title,
        summary: signal.detail,
        action,
        contain: settings.incidentAutoContain,
      });
    }
  }
  // Raise the agent's risk score now rather than at the nightly run.
  const { recomputeRisk } = await import("./governance.service.js");
  await recomputeRisk(agent).catch(() => undefined);
}

/* ------------------------------ Re-approval ------------------------------ */

/** A person approved an agent after an incident: it may act on its own again. */
export async function clearReapproval(agentId: string): Promise<void> {
  await AgentModel.updateOne({ _id: agentId }, { $set: { reapprovalRequired: false } });
  agentService.invalidate(agentId);
}
