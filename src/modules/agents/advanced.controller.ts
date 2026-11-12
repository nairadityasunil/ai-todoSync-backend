import type { Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import projectService from "../project/services/project.service.js";
import ProjectModel from "../project/models/project.model.js";
import TaskModel from "../task/models/task.model.js";
import { CLASSIFICATIONS, diffPolicies, isClassification, PLAYBOOK_STEP_TYPES, PLAYBOOK_TEMPLATES, PLAYBOOK_TRIGGERS, type PolicySnapshot } from "./advanced.js";
import {
  AgentElevationModel,
  AgentPlaybookModel,
  AgentPolicyVersionModel,
  PlaybookRunModel,
} from "./advanced.model.js";
import {
  baselineFor,
  canDecideElevation,
  changeCounter,
  computeBaselineFor,
  decideElevation,
  endElevation,
  invalidateLabels,
  requestElevation,
  revealPendingKey,
  runKeyLifecycle,
  serializeElevation,
} from "./advanced.service.js";
import { scheduleComplianceCheck } from "./compliance.service.js";
import { logGovernanceEvent } from "./hybrid.service.js";
import { adminWorkspaces, param, requireWorkspace, str, userIdOf } from "./http.js";
import { AgentModel, AgentPolicyModel } from "./model.js";
import { cancelRun, continueRun, sanitizePlaybook, serializePlaybook, serializeRun, stepLabel } from "./playbooks.service.js";
import { applySnapshot, listVersions, rollback, serializeVersion, simulate, snapshotOf } from "./policy-versions.service.js";

/** An agent the caller owns or administers. */
async function loadVisibleAgent(req: AuthenticatedRequest, userId: string) {
  const admin = await adminWorkspaces(userId);
  const agent = await AgentModel.findOne({
    _id: param(req, "agentId"),
    $or: [{ ownerUserId: new Types.ObjectId(userId) }, { workspaceId: { $in: admin } }],
  });
  if (!agent) throw new AppError(404, "Agent not found", "NOT_FOUND");
  return { agent, admin, isOwner: String(agent.ownerUserId) === userId };
}

class AdvancedGovernanceController {
  /* --------------------------- Baselines --------------------------- */

  public baseline = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { agent } = await loadVisibleAgent(req, userId);
    const baseline = req.query.refresh === "1" ? await computeBaselineFor(agent) : await baselineFor(agent._id.toString());
    const lastHour = changeCounter.count(agent._id.toString());
    res.json({
      success: true,
      data: {
        baseline,
        current: {
          changesLastHour: lastHour,
          ratio: baseline?.ready ? Math.round((lastHour / Math.max(1, baseline.hourlyP95)) * 10) / 10 : null,
        },
      },
    });
  };

  public recomputeBaseline = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { agent } = await loadVisibleAgent(req, userId);
    res.json({ success: true, data: { baseline: await computeBaselineFor(agent) } });
  };

  /* ----------------------- Just-in-time access ---------------------- */

  /** An agent asks for scopes for a while. People do not use this. */
  public requestElevation = async (req: AuthenticatedRequest, res: Response) => {
    userIdOf(req);
    if (!req.agent) throw new AppError(400, "Only an agent can ask for just-in-time access, with its own key.", "BAD_REQUEST");
    const elevation = await requestElevation(req.agent, (req.body ?? {}) as Record<string, unknown>);
    res.status(elevation.status === "active" ? 201 : 202).json({
      success: true,
      message:
        elevation.status === "active"
          ? `Granted until ${elevation.expiresAt.toISOString()}.`
          : "Waiting for a person. Poll the statusUrl; the scopes apply as soon as it is granted.",
      data: { ...serializeElevation(elevation), statusUrl: `/api/agents/elevations/${elevation._id}` },
    });
  };

  public listElevations = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    const filter: Record<string, unknown> = req.agent
      ? { agentId: req.agent._id }
      : { $or: [{ ownerUserId: new Types.ObjectId(userId) }, { workspaceId: { $in: admin } }] };
    const status = str(req.query.status);
    if (status) filter.status = { $in: status.split(",") };
    const agentId = str(req.query.agentId);
    if (agentId && Types.ObjectId.isValid(agentId) && !req.agent) filter.agentId = new Types.ObjectId(agentId);
    const rows = await AgentElevationModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 50))
      .populate("agentId", "name kind operatedBy riskLevel")
      .populate("decidedBy", "name email")
      .lean();
    res.json({ success: true, data: rows.map((r) => serializeElevation(r)) });
  };

  private loadElevation = async (req: AuthenticatedRequest, userId: string) => {
    const admin = await adminWorkspaces(userId);
    const elevation = await AgentElevationModel.findOne({
      _id: param(req, "elevationId"),
      ...(req.agent ? { agentId: req.agent._id } : { $or: [{ ownerUserId: new Types.ObjectId(userId) }, { workspaceId: { $in: admin } }] }),
    });
    if (!elevation) throw new AppError(404, "Request not found", "NOT_FOUND");
    return { elevation, admin };
  };

  public getElevation = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { elevation } = await this.loadElevation(req, userId);
    res.json({ success: true, data: serializeElevation(elevation) });
  };

  private decide = (decision: "approve" | "reject") => async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { elevation, admin } = await this.loadElevation(req, userId);
    if (!(await canDecideElevation(elevation, userId, admin))) {
      throw new AppError(403, "Only a workspace admin (or the agent's owner, unless an admin restricted it) can decide this.", "FORBIDDEN");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await decideElevation(elevation, userId, decision, { minutes: body.durationMinutes, note: str(body.note) ?? null });
    res.json({ success: true, data: serializeElevation(result) });
  };

  public approveElevation = this.decide("approve");
  public rejectElevation = this.decide("reject");

  public revokeElevation = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { elevation } = await this.loadElevation(req, userId);
    res.json({ success: true, data: serializeElevation(await endElevation(elevation, userId)) });
  };

  /* ------------------------- Data labels ---------------------------- */

  public getClassification = async (req: AuthenticatedRequest, res: Response) => {
    userIdOf(req);
    const projectIds = (str(req.query.projectIds) ?? str(req.query.projectId) ?? "").split(",").filter((id) => Types.ObjectId.isValid(id)).slice(0, 200);
    const taskIds = (str(req.query.taskIds) ?? str(req.query.taskId) ?? "").split(",").filter((id) => Types.ObjectId.isValid(id)).slice(0, 500);
    const [projects, tasks] = await Promise.all([
      projectIds.length ? ProjectModel.find({ _id: { $in: projectIds } }).select("classification").lean() : [],
      taskIds.length ? TaskModel.find({ _id: { $in: taskIds } }).select("classification projectId").lean() : [],
    ]);
    res.json({
      success: true,
      data: {
        labels: CLASSIFICATIONS,
        projects: Object.fromEntries(projects.map((p) => [String(p._id), (p as { classification?: string | null }).classification ?? null])),
        tasks: Object.fromEntries(tasks.map((t) => [String(t._id), (t as { classification?: string | null }).classification ?? null])),
      },
    });
  };

  /** Labels a project or a task (null clears it: a task then inherits its project's). Project admins only. */
  public setClassification = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = body.classification === null || body.classification === "" ? null : body.classification;
    if (label !== null && !isClassification(label)) throw new AppError(400, `classification must be one of ${CLASSIFICATIONS.join(", ")}, or null`, "BAD_REQUEST");
    const taskId = str(body.taskId);
    const projectId = str(body.projectId);
    let targetProject: string | null = projectId ?? null;
    let title = "";
    if (taskId) {
      if (!Types.ObjectId.isValid(taskId)) throw new AppError(404, "Task not found", "NOT_FOUND");
      const task = await TaskModel.findById(taskId).select("projectId title userId").lean();
      if (!task) throw new AppError(404, "Task not found", "NOT_FOUND");
      if (!task.projectId) {
        if (String(task.userId) !== userId) throw new AppError(403, "Only the task's owner can label it", "FORBIDDEN");
      } else targetProject = String(task.projectId);
      title = `task "${task.title}"`;
    }
    if (targetProject) {
      if (!Types.ObjectId.isValid(targetProject)) throw new AppError(404, "Project not found", "NOT_FOUND");
      await projectService.assertProjectRole(userId, targetProject, "ADMIN").catch(() => {
        throw new AppError(403, "Only project admins can change data labels", "FORBIDDEN");
      });
    } else if (!taskId) throw new AppError(400, "Name a projectId or a taskId", "BAD_REQUEST");
    let workspaceId: string | null = null;
    if (taskId) {
      await TaskModel.updateOne({ _id: taskId }, { $set: { classification: label } });
      invalidateLabels(`t:${taskId}`);
    } else {
      await ProjectModel.updateOne({ _id: targetProject }, { $set: { classification: label } });
      const project = await ProjectModel.findById(targetProject).select("name workspaceId").lean();
      if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");
      title = `project "${project.name}"`;
      invalidateLabels(`p:${targetProject}`);
    }
    if (targetProject) {
      const project = await ProjectModel.findById(targetProject).select("workspaceId").lean();
      workspaceId = project?.workspaceId ? String(project.workspaceId) : null;
    }
    await logGovernanceEvent({
      workspaceId,
      type: "classification_changed",
      actor: "person",
      userId,
      title: `Labelled ${title} ${label ?? (taskId ? "as its project" : "internal (default)")}`,
      detail: label === "restricted" ? "Agents cannot send it to AI models or export it; their changes are high risk." : label === "confidential" ? "Agents' changes need a person; personal data in it never goes to AI models." : "",
    });
    res.json({ success: true, data: { projectId: taskId ? null : targetProject, taskId: taskId ?? null, classification: label } });
  };

  /* -------------------------- Key lifecycle -------------------------- */

  public runKeyLifecycle = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    res.json({ success: true, data: await runKeyLifecycle({ workspaceId: workspaceId.toString() }) });
  };

  /** The owner collects a key the system rotated. Shown once. */
  public revealPendingKey = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { agent, isOwner } = await loadVisibleAgent(req, userId);
    if (!isOwner) throw new AppError(403, "Only the key's owner can collect it", "FORBIDDEN");
    const key = await revealPendingKey(agent);
    await logGovernanceEvent({
      workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
      type: "key_collected",
      actor: "person",
      userId,
      agentId: agent._id.toString(),
      title: `Collected the rotated key for ${agent.name}`,
    });
    res.json({ success: true, message: "Copy this key now: it will not be shown again.", data: { key, previousKeyExpiresAt: agent.previousKeyExpiresAt ?? null } });
  };

  /* ----------------------------- Policies ---------------------------- */

  public simulate = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { sanitizePolicyInput } = await import("./controller.js");
    const draft = body.policy && typeof body.policy === "object" ? (sanitizePolicyInput(body.policy as Record<string, unknown>) as unknown as PolicySnapshot) : null;
    const policyId = str(body.policyId);
    if (policyId && !Types.ObjectId.isValid(policyId)) throw new AppError(404, "Policy not found", "NOT_FOUND");
    if (!draft && !policyId) throw new AppError(400, "Send a policy to try, or a policyId", "BAD_REQUEST");
    res.json({
      success: true,
      data: await simulate({ workspaceId: workspaceId.toString(), draft, policyId: policyId ?? null, remove: body.remove === true, days: Number(body.days) || 7 }),
    });
  };

  public versions = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    res.json({ success: true, data: await listVersions(param(req, "policyId"), admin) });
  };

  public rollback = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    const version = Number((req.body as Record<string, unknown>)?.version);
    if (!Number.isInteger(version) || version < 1) throw new AppError(400, "version is required", "BAD_REQUEST");
    const result = await rollback(param(req, "policyId"), version, admin, userId);
    if (result.policy) scheduleComplianceCheck(String(result.policy.workspaceId), "policy rollback");
    res.json({
      success: true,
      data: { policy: result.policy ? { ...result.policy.toObject(), id: result.policy._id.toString() } : null, version: serializeVersion(result.version) },
    });
  };

  public proposals = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    const rows = await AgentPolicyVersionModel.find({ workspaceId: { $in: admin }, status: str(req.query.status) ?? "proposed" })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("changedBy", "name email")
      .lean();
    res.json({ success: true, data: rows.map((r) => ({ ...serializeVersion(r), canDecide: String((r.changedBy as { _id?: unknown })?._id ?? r.changedBy) !== userId })) });
  };

  private loadProposal = async (req: AuthenticatedRequest, userId: string) => {
    const admin = await adminWorkspaces(userId);
    const proposal = await AgentPolicyVersionModel.findOne({ _id: param(req, "versionId"), workspaceId: { $in: admin } });
    if (!proposal) throw new AppError(404, "Proposal not found", "NOT_FOUND");
    if (proposal.status !== "proposed") throw new AppError(409, `This change is already ${proposal.status}`, "CONFLICT");
    return proposal;
  };

  /** A second admin approves a proposed policy change; it applies now. */
  public approveProposal = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const proposal = await this.loadProposal(req, userId);
    if (String(proposal.changedBy) === userId) {
      const admins = await import("../workspace/models/workspace-member.model.js").then((m) =>
        m.default.countDocuments({ workspaceId: proposal.workspaceId, role: { $in: ["OWNER", "ADMIN"] } }),
      );
      if (admins > 1) throw new AppError(403, "Another admin must approve your change", "FORBIDDEN");
    }
    // The change applies on top of the policy as it is now.
    const current = await AgentPolicyModel.findOne({ _id: proposal.policyId, workspaceId: proposal.workspaceId });
    if (proposal.action !== "created" && !current) throw new AppError(409, "The policy no longer exists", "CONFLICT");
    const policy = await applySnapshot(proposal.workspaceId, proposal.policyId, (proposal.snapshot as PolicySnapshot | null) ?? null, String(proposal.changedBy));
    proposal.status = "applied";
    proposal.previous = current ? snapshotOf(current) : null;
    proposal.reviewedBy = new Types.ObjectId(userId);
    proposal.reviewedAt = new Date();
    await proposal.save();
    scheduleComplianceCheck(String(proposal.workspaceId), "policy change");
    await logGovernanceEvent({
      workspaceId: String(proposal.workspaceId),
      type: "policy_change_approved",
      actor: "person",
      userId,
      title: `Approved a change to policy "${(proposal.snapshot as PolicySnapshot | null)?.name ?? (proposal.previous as PolicySnapshot | null)?.name ?? ""}"`,
      detail: diffPolicies(proposal.previous as PolicySnapshot | null, proposal.snapshot as PolicySnapshot | null).map((c) => c.field).join(", ") || proposal.action,
    });
    res.json({ success: true, data: { version: serializeVersion(proposal), policy: policy ? { ...policy.toObject(), id: policy._id.toString() } : null } });
  };

  public rejectProposal = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const proposal = await this.loadProposal(req, userId);
    proposal.status = String(proposal.changedBy) === userId ? "withdrawn" : "rejected";
    proposal.reviewedBy = new Types.ObjectId(userId);
    proposal.reviewedAt = new Date();
    proposal.note = str((req.body as Record<string, unknown>)?.note) ?? proposal.note ?? null;
    await proposal.save();
    await logGovernanceEvent({
      workspaceId: String(proposal.workspaceId),
      type: `policy_change_${proposal.status}`,
      actor: "person",
      userId,
      title: `${proposal.status === "withdrawn" ? "Withdrew" : "Rejected"} a change to policy "${(proposal.snapshot as PolicySnapshot | null)?.name ?? (proposal.previous as PolicySnapshot | null)?.name ?? ""}"`,
      detail: proposal.note ?? "",
    });
    res.json({ success: true, data: serializeVersion(proposal) });
  };

  /** Governance as code: every policy as JSON, with its current version. */
  public exportPolicies = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const policies = await AgentPolicyModel.find({ workspaceId }).sort({ priority: -1 }).lean();
    const versionOf = new Map<string, number>();
    for (const v of await AgentPolicyVersionModel.find({ workspaceId, status: "applied" }).select("policyId version -_id").lean()) {
      versionOf.set(String(v.policyId), Math.max(versionOf.get(String(v.policyId)) ?? 0, v.version));
    }
    res.setHeader("Content-Disposition", `attachment; filename="agent-policies-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      workspaceId: workspaceId.toString(),
      policies: policies.map((p) => ({ id: String(p._id), version: versionOf.get(String(p._id)) ?? 1, ...snapshotOf(p) })),
    });
  };

  /* ----------------------------- Playbooks ---------------------------- */

  public playbookTemplates = async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: {
        templates: PLAYBOOK_TEMPLATES.map((t) => ({ ...t, steps: t.steps.map((type) => ({ type, label: stepLabel(type) })) })),
        triggers: PLAYBOOK_TRIGGERS,
        steps: PLAYBOOK_STEP_TYPES.map((type) => ({ type, label: stepLabel(type) })),
      },
    });
  };

  public listPlaybooks = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const rows = await AgentPlaybookModel.find({ workspaceId }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, data: rows.map((r) => ({ ...serializePlaybook(r), steps: r.steps.map((s) => ({ type: s.type, label: stepLabel(s.type) })) })) });
  };

  public createPlaybook = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const template = PLAYBOOK_TEMPLATES.find((t) => t.key === str(body.template));
    const data = sanitizePlaybook(template ? { name: template.name, description: template.description, trigger: template.trigger, steps: template.steps, ...body } : body);
    const playbook = await AgentPlaybookModel.create({ ...data, workspaceId, createdBy: userId });
    await logGovernanceEvent({ workspaceId: workspaceId.toString(), type: "playbook_created", actor: "person", userId, title: `Added playbook "${playbook.name}"`, detail: data.steps.map((s) => stepLabel(s.type)).join(" → ") });
    res.status(201).json({ success: true, data: serializePlaybook(playbook) });
  };

  private loadPlaybook = async (req: AuthenticatedRequest, userId: string) => {
    const admin = await adminWorkspaces(userId);
    const playbook = await AgentPlaybookModel.findOne({ _id: param(req, "playbookId"), workspaceId: { $in: admin } });
    if (!playbook) throw new AppError(404, "Playbook not found", "NOT_FOUND");
    return playbook;
  };

  public updatePlaybook = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const playbook = await this.loadPlaybook(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = sanitizePlaybook({ ...playbook.toObject(), ...body });
    playbook.set(data);
    await playbook.save();
    res.json({ success: true, data: serializePlaybook(playbook) });
  };

  public deletePlaybook = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const playbook = await this.loadPlaybook(req, userId);
    await playbook.deleteOne();
    await logGovernanceEvent({ workspaceId: String(playbook.workspaceId), type: "playbook_deleted", actor: "person", userId, title: `Removed playbook "${playbook.name}"` });
    res.json({ success: true, data: { deleted: true } });
  };

  public listRuns = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    const filter: Record<string, unknown> = { workspaceId: { $in: admin } };
    const status = str(req.query.status);
    if (status) filter.status = { $in: status.split(",") };
    const rows = await PlaybookRunModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 50))
      .populate("agentId", "name kind status")
      .populate("decidedBy", "name email")
      .lean();
    res.json({ success: true, data: rows.map((r) => serializeRun(r)) });
  };

  private loadRun = async (req: AuthenticatedRequest, userId: string) => {
    const admin = await adminWorkspaces(userId);
    const run = await PlaybookRunModel.findOne({ _id: param(req, "runId"), workspaceId: { $in: admin } });
    if (!run) throw new AppError(404, "Run not found", "NOT_FOUND");
    return run;
  };

  public continueRun = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const run = await this.loadRun(req, userId);
    res.json({ success: true, data: serializeRun(await continueRun(run, userId)) });
  };

  public cancelRun = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const run = await this.loadRun(req, userId);
    res.json({ success: true, data: serializeRun(await cancelRun(run, userId, str((req.body as Record<string, unknown>)?.note) ?? null)) });
  };
}

export default new AdvancedGovernanceController();
