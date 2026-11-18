import type { Response } from "express";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import agentService from "../agents/agent.service.js";
import { adminWorkspaces, str, userIdOf } from "../agents/http.js";
import ProjectModel from "../project/models/project.model.js";
import projectService from "../project/services/project.service.js";
import { AUTOMATION_RULES, RETENTION_OPTIONS } from "./automation.js";
import {
  automationSettings,
  governanceReady,
  runFeedbackLoop,
  saveAutomationSettings,
  syncTenant,
  syncWorkspace,
} from "./automation.service.js";
import {
  agentTelemetry,
  automationForTask,
  automationTasks,
  governanceTelemetry,
  healthSignals,
  journey,
  recentPeople,
  type Scope,
} from "./metrics.service.js";

/** The workspace a request is about (?workspaceId, else the person's own) and whether they administer it. */
async function scopeOf(req: AuthenticatedRequest): Promise<Scope> {
  const userId = userIdOf(req);
  const admin = await adminWorkspaces(userId);
  const requested =
    str(req.query.workspaceId) ??
    str((req.body as Record<string, unknown> | undefined)?.workspaceId);
  const workspaceId =
    requested ??
    admin[0]?.toString() ??
    (await agentService.defaultWorkspaceId(userId));
  if (!workspaceId) throw new AppError(404, "No workspace found", "NOT_FOUND");
  if (
    requested &&
    !admin.some((id) => id.toString() === requested) &&
    (await agentService.defaultWorkspaceId(userId)) !== requested
  ) {
    throw new AppError(
      403,
      "You are not a member of this workspace",
      "FORBIDDEN",
    );
  }
  return {
    userId,
    workspaceId,
    isAdmin: admin.some((id) => id.toString() === workspaceId),
  };
}

const adminScope = async (req: AuthenticatedRequest): Promise<Scope> => {
  const scope = await scopeOf(req);
  if (!scope.isAdmin)
    throw new AppError(
      403,
      "Only workspace owners and admins can do this",
      "FORBIDDEN",
    );
  return scope;
};

const days = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.round(n)) : fallback;
};

class TelemetryController {
  public health = async (req: AuthenticatedRequest, res: Response) => {
    res.json({ success: true, data: await healthSignals(await scopeOf(req)) });
  };

  public governance = async (req: AuthenticatedRequest, res: Response) => {
    const scope = await adminScope(req);
    res.json({
      success: true,
      data: await governanceTelemetry(
        scope.workspaceId,
        days(req.query.days, 30, 90),
      ),
    });
  };

  public agents = async (req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: await agentTelemetry(
        await scopeOf(req),
        days(req.query.days, 7, 90),
      ),
    });
  };

  public people = async (req: AuthenticatedRequest, res: Response) => {
    const data = await recentPeople(
      userIdOf(req),
      String(req.query.integrationId ?? ""),
      str(req.query.q),
    );
    if (!data) throw new AppError(404, "Integration not found", "NOT_FOUND");
    res.json({ success: true, data });
  };

  public journey = async (req: AuthenticatedRequest, res: Response) => {
    const data = await journey(
      userIdOf(req),
      String(req.query.integrationId ?? ""),
      { user: str(req.query.user), session: str(req.query.session) },
    );
    if (!data) throw new AppError(404, "Integration not found", "NOT_FOUND");
    res.json({ success: true, data });
  };

  public automation = async (req: AuthenticatedRequest, res: Response) => {
    const scope = await scopeOf(req);
    res.json({
      success: true,
      data: {
        canAdmin: scope.isAdmin,
        settings: await automationSettings(scope.workspaceId),
        rules: AUTOMATION_RULES,
        retentionOptions: RETENTION_OPTIONS,
        tasks: await automationTasks(scope),
      },
    });
  };

  public updateAutomation = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const scope = await adminScope(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId === "string" && body.projectId) {
      const project = await ProjectModel.findOne({
        _id: body.projectId,
        workspaceId: scope.workspaceId,
      })
        .select("_id")
        .lean()
        .catch(() => null);
      if (!project)
        throw new AppError(
          400,
          "Choose a project in this workspace",
          "BAD_REQUEST",
        );
      await projectService.assertProjectRole(
        scope.userId,
        body.projectId,
        "MEMBER",
      );
    }
    res.json({
      success: true,
      data: { settings: await saveAutomationSettings(scope.workspaceId, body) },
    });
  };

  /** Checks everything now instead of waiting for the next scheduled run. */
  public run = async (req: AuthenticatedRequest, res: Response) => {
    const scope = await scopeOf(req);
    const own = await syncTenant(scope.userId);
    const workspace = scope.isAdmin
      ? await syncWorkspace(scope.workspaceId)
      : { opened: 0, closed: 0, completedByPerson: 0, escalated: 0 };
    const measured = await runFeedbackLoop();
    res.json({
      success: true,
      data: {
        opened: own.opened + workspace.opened,
        closed: own.closed + workspace.closed,
        measured,
        tasks: await automationTasks(scope),
      },
    });
  };

  public forTask = async (req: AuthenticatedRequest, res: Response) => {
    userIdOf(req);
    res.json({
      success: true,
      data: await automationForTask(String(req.params.taskId)),
    });
  };

  /** Governance state of every project the caller belongs to, keyed by project id. */
  public projectGovernance = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const userId = userIdOf(req);
    const ids = (await projectService.fetchProjects(userId)).map((p) => p.id);
    res.json({ success: true, data: await governanceReady(ids) });
  };

  /** Governance state of one project: ready, pending, or null when the caller is not in it. */
  public projectGovernanceOne = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const userId = userIdOf(req);
    const projectId = String(req.params.projectId);
    const mine = new Set(
      (await projectService.fetchProjects(userId)).map((p) => p.id),
    );
    const state = mine.has(projectId)
      ? ((await governanceReady([projectId]))[projectId] ?? null)
      : null;
    res.json({ success: true, data: { state } });
  };
}

export default new TelemetryController();
