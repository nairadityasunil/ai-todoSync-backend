import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import EmailService from "../../shared/services/email.service.js";
import { AppError } from "../../utils/app-error.js";
import { playbookMatches, PLAYBOOK_STEP_TYPES, PLAYBOOK_TRIGGERS, type PlaybookStepType } from "./advanced.js";
import {
  AgentPlaybookModel,
  PlaybookRunModel,
  type IAgentPlaybookDocument,
  type IPlaybookRunDocument,
} from "./advanced.model.js";
import { workspaceAdminEmails } from "./advanced.service.js";
import agentService from "./agent.service.js";
import approvalService from "./approval.service.js";
import { logGovernanceEvent, openIncident, systemSuspend } from "./hybrid.service.js";
import { AgentIncidentModel, AgentModel, type IAgentDocument } from "./model.js";
import webhookService from "./webhooks.service.js";

/**
 * Playbooks: when a threat, DLP, anomaly or compliance alert fires, run a set
 * of steps. Automatic steps run at once; a "wait for a person" step pauses the
 * run until someone continues or stops it. Every step is recorded.
 */

export interface PlaybookAlert {
  workspaceId: string | null;
  agentId?: string | null;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
}

/** The same playbook does not run twice for the same agent within this time. */
const COOLDOWN_MS = 30 * 60_000;

const STEP_LABEL: Record<PlaybookStepType, string> = {
  suspend_agent: "Suspend the agent",
  require_reapproval: "Require a person's approval for its next change",
  create_incident: "Open an incident",
  notify: "Notify the security channel",
  wait_for_approval: "Wait for a person",
  revoke_agent: "Revoke the agent",
};

export const stepLabel = (type: string): string => STEP_LABEL[type as PlaybookStepType] ?? type;

export function sanitizePlaybook(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) throw new AppError(400, "Playbook name is required", "BAD_REQUEST");
  const trigger = (body.trigger && typeof body.trigger === "object" ? body.trigger : {}) as Record<string, unknown>;
  const types = Array.isArray(trigger.types)
    ? [...new Set(trigger.types.map(String).filter((t) => (PLAYBOOK_TRIGGERS as readonly string[]).includes(t)))]
    : [];
  if (!types.length) throw new AppError(400, `Pick at least one trigger: ${PLAYBOOK_TRIGGERS.join(", ")}`, "BAD_REQUEST");
  const minSeverity = ["info", "warning", "critical"].includes(String(trigger.minSeverity)) ? (trigger.minSeverity as "info" | "warning" | "critical") : "critical";
  const steps = Array.isArray(body.steps)
    ? body.steps
        .map((step) => (typeof step === "string" ? step : (step as { type?: unknown })?.type))
        .filter((t): t is PlaybookStepType => typeof t === "string" && (PLAYBOOK_STEP_TYPES as readonly string[]).includes(t))
        .slice(0, 12)
    : [];
  if (!steps.length) throw new AppError(400, "Add at least one step", "BAD_REQUEST");
  return {
    name,
    description: typeof body.description === "string" ? body.description.trim().slice(0, 500) : "",
    enabled: body.enabled !== false,
    trigger: { types, minSeverity },
    steps: steps.map((type) => ({ type })),
  };
}

/** Revoked by the system (a playbook step a person confirmed). */
async function systemRevoke(agent: IAgentDocument, reason: string): Promise<boolean> {
  if (agent.status === "revoked") return false;
  agent.status = "revoked";
  agent.suspendedBySystem = false;
  agent.statusReason = `Revoked: ${reason}`.slice(0, 300);
  if (agent.kind === "api_key") {
    agent.keyHash = null;
    agent.previousKeyHash = null;
    agent.pendingKeyCiphertext = null;
  }
  await agent.save();
  agentService.invalidate(agent._id.toString());
  await approvalService.expireForAgents([agent._id]);
  return true;
}

/** Runs steps from `from` until the end or a wait step. */
async function execute(run: IPlaybookRunDocument, from: number, actor: "system" | "person"): Promise<IPlaybookRunDocument> {
  const agent = run.agentId ? await AgentModel.findById(run.agentId) : null;
  const workspaceId = run.workspaceId ? String(run.workspaceId) : null;
  run.status = "running";
  for (let i = from; i < run.steps.length; i += 1) {
    const step = run.steps[i];
    const done = (detail: string, status: "done" | "skipped" | "failed" = "done") => {
      step.status = status;
      step.detail = detail;
      step.at = new Date();
      step.actor = actor === "person" && i === from ? "person" : "system";
    };
    try {
      switch (step.type as PlaybookStepType) {
        case "suspend_agent":
          if (!agent) done("No agent involved.", "skipped");
          else done((await systemSuspend(agent, `Playbook "${run.playbookName}": ${run.trigger.title}`, run.incidentId ? String(run.incidentId) : null)) ? `Suspended ${agent.name}.` : `${agent.name} was already ${agent.status}.`);
          break;
        case "require_reapproval":
          if (!agent) done("No agent involved.", "skipped");
          else {
            await AgentModel.updateOne({ _id: agent._id }, { $set: { reapprovalRequired: true } });
            agentService.invalidate(agent._id.toString());
            done(`${agent.name}'s next change needs a person's approval.`);
          }
          break;
        case "create_incident": {
          // An incident the system already opened for this agent counts: link it rather than open a second.
          const existing = agent
            ? await AgentIncidentModel.findOne({ agentIds: agent._id, status: { $ne: "resolved" }, createdAt: { $gte: new Date(Date.now() - 3600_000) } }).sort({ createdAt: -1 })
            : null;
          if (existing) {
            existing.timeline.push({ at: new Date(), actor: "system", action: "playbook", detail: `Playbook "${run.playbookName}" is handling it.` });
            await existing.save();
            run.incidentId = existing._id;
            done("Linked to the open incident.");
            break;
          }
          const incident = await openIncident({
            workspaceId,
            agents: agent ? [agent] : [],
            trigger: run.trigger.type,
            severity: run.trigger.severity === "critical" ? "critical" : "warning",
            title: run.trigger.title,
            summary: `${run.trigger.detail} (playbook "${run.playbookName}")`,
            contain: false,
          });
          if (incident) run.incidentId = incident._id;
          done(incident ? "Incident opened." : "Could not open an incident.", incident ? "done" : "failed");
          break;
        }
        case "notify": {
          webhookService.emit({
            type: "playbook.run",
            workspaceId,
            severity: run.trigger.severity as "info" | "warning" | "critical",
            summary: `Playbook "${run.playbookName}": ${run.trigger.title}`,
            data: { runId: run._id.toString(), playbook: run.playbookName, agentId: run.agentId ? String(run.agentId) : null, agentName: agent?.name ?? null, trigger: run.trigger },
          });
          const emails = workspaceId ? await workspaceAdminEmails(workspaceId) : [];
          await Promise.all(
            emails.map((email) =>
              EmailService.sendEmail(email, `Pristine playbook: ${run.trigger.title}`, `${run.trigger.detail}\n\nPlaybook "${run.playbookName}" is running. Review it in Agent Governance → Incidents.`).catch(() => false),
            ),
          );
          done(`Sent to the workspace's webhooks and ${emails.length} admin(s).`);
          break;
        }
        case "wait_for_approval":
          if (actor === "person" && i === from) {
            done("A person confirmed the remaining steps.");
            break;
          }
          step.status = "waiting";
          step.detail = "Waiting for a person to continue or stop.";
          step.at = new Date();
          run.status = "waiting";
          await run.save();
          return run;
        case "revoke_agent":
          if (!agent) done("No agent involved.", "skipped");
          else done((await systemRevoke(agent, `playbook "${run.playbookName}"`)) ? `Revoked ${agent.name}.` : `${agent.name} was already revoked.`);
          break;
        default:
          done("Unknown step.", "skipped");
      }
    } catch (error) {
      done(error instanceof Error ? error.message : "Step failed.", "failed");
    }
  }
  run.status = run.steps.some((s) => s.status === "failed") ? "failed" : "completed";
  await run.save();
  return run;
}

/** Starts every enabled playbook whose trigger matches a new alert. */
export async function triggerPlaybooks(alert: PlaybookAlert): Promise<number> {
  if (!alert.workspaceId) return 0;
  const playbooks = await AgentPlaybookModel.find({ workspaceId: alert.workspaceId, enabled: true }).lean();
  let started = 0;
  for (const playbook of playbooks) {
    if (!playbookMatches(playbook.trigger, alert)) continue;
    const recent = await PlaybookRunModel.exists({
      playbookId: playbook._id,
      agentId: alert.agentId ? new Types.ObjectId(alert.agentId) : null,
      createdAt: { $gte: new Date(Date.now() - COOLDOWN_MS) },
    });
    if (recent) continue;
    try {
      const run = await PlaybookRunModel.create({
        workspaceId: alert.workspaceId,
        playbookId: playbook._id,
        playbookName: playbook.name,
        agentId: alert.agentId ?? null,
        trigger: { type: alert.type, severity: alert.severity, title: alert.title, detail: alert.detail },
        status: "running",
        steps: playbook.steps.map((s) => ({ type: s.type, status: "pending" })),
      });
      await AgentPlaybookModel.updateOne({ _id: playbook._id }, { $set: { lastRunAt: new Date() }, $inc: { runCount: 1 } });
      await execute(run, 0, "system");
      started += 1;
      await logGovernanceEvent({
        workspaceId: alert.workspaceId,
        type: "playbook_run",
        actor: "system",
        agentId: alert.agentId ?? null,
        incidentId: run.incidentId ? String(run.incidentId) : null,
        title: `Playbook "${playbook.name}" ran: ${alert.title}`,
        detail: run.steps.map((s) => `${stepLabel(s.type)}: ${s.status}`).join("; "),
      });
    } catch (error) {
      logger.warn("Playbook run failed", { playbookId: String(playbook._id), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return started;
}

/** A person continues a paused run (the wait step and everything after it). */
export async function continueRun(run: IPlaybookRunDocument, userId: string): Promise<IPlaybookRunDocument> {
  if (run.status !== "waiting") throw new AppError(409, `This run is ${run.status}.`, "CONFLICT");
  const index = run.steps.findIndex((s) => s.status === "waiting");
  run.decidedBy = new Types.ObjectId(userId);
  run.decidedAt = new Date();
  const result = await execute(run, index, "person");
  await logGovernanceEvent({
    workspaceId: run.workspaceId ? String(run.workspaceId) : null,
    type: "playbook_continued",
    actor: "person",
    userId,
    agentId: run.agentId ? String(run.agentId) : null,
    title: `Continued playbook "${run.playbookName}"`,
    detail: result.steps.slice(index).map((s) => `${stepLabel(s.type)}: ${s.status}`).join("; "),
  });
  return result;
}

/** A person stops a paused run; the remaining steps are skipped. */
export async function cancelRun(run: IPlaybookRunDocument, userId: string, note?: string | null): Promise<IPlaybookRunDocument> {
  if (run.status !== "waiting" && run.status !== "running") throw new AppError(409, `This run is ${run.status}.`, "CONFLICT");
  for (const step of run.steps) {
    if (step.status === "pending" || step.status === "waiting") {
      step.status = "skipped";
      step.detail = note ? `Stopped by a person: ${note}` : "Stopped by a person.";
      step.at = new Date();
      step.actor = "person";
    }
  }
  run.status = "cancelled";
  run.decidedBy = new Types.ObjectId(userId);
  run.decidedAt = new Date();
  await run.save();
  await logGovernanceEvent({
    workspaceId: run.workspaceId ? String(run.workspaceId) : null,
    type: "playbook_cancelled",
    actor: "person",
    userId,
    agentId: run.agentId ? String(run.agentId) : null,
    title: `Stopped playbook "${run.playbookName}"`,
    detail: note ?? "",
  });
  return run;
}

export const serializePlaybook = (p: IAgentPlaybookDocument | Record<string, unknown>) => {
  const plain = (typeof (p as IAgentPlaybookDocument).toObject === "function" ? (p as IAgentPlaybookDocument).toObject() : p) as Record<string, unknown>;
  return { ...plain, id: String(plain._id) };
};

export const serializeRun = (r: IPlaybookRunDocument | Record<string, unknown>) => {
  const plain = (typeof (r as IPlaybookRunDocument).toObject === "function" ? (r as IPlaybookRunDocument).toObject() : r) as Record<string, unknown>;
  return {
    ...plain,
    id: String(plain._id),
    steps: ((plain.steps as Array<Record<string, unknown>>) ?? []).map((s) => ({ ...s, label: stepLabel(String(s.type)) })),
  };
};
