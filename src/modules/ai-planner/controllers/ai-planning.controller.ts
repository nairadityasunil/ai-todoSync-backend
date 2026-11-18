import type { Response } from "express";

import projectService from "../../project/services/project.service.js";
import aiPlanningService from "../services/ai-planning.service.js";
import type { AuthenticatedRequest } from "../../../types/auth.js";

const getParam = (value: string | string[] | undefined): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? (value[0] ?? "")
      : "";

class AiPlanningController {
  public getSettings = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      settings: await aiPlanningService.getSettings(userId, projectId),
    }));
  };

  public updateSettings = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      settings: await aiPlanningService.updateSettings(
        userId,
        projectId,
        req.body,
      ),
    }));
  };

  public testConnection = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      result: await aiPlanningService.testConnection(
        userId,
        projectId,
        req.body,
      ),
    }));
  };

  public getContext = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      context: await aiPlanningService.getContext(userId, projectId),
    }));
  };

  public listWorkspaceSessions = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const rawWsId =
        (req.query.workspaceId as string) || (req.params as any)?.workspaceId;
      const workspaceId =
        typeof rawWsId === "string" && rawWsId.trim()
          ? rawWsId.trim()
          : undefined;
      const sessions = await aiPlanningService.listWorkspaceSessions(
        req.user._id.toString(),
        workspaceId,
      );
      res
        .status(200)
        .json({ message: "Workspace sessions fetched", data: { sessions } });
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };

  public createWorkspaceSession = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { workspaceId: rawWsId, title } = req.body;
      const workspaceId =
        typeof rawWsId === "string" && rawWsId.trim()
          ? rawWsId.trim()
          : undefined;
      const session = await aiPlanningService.createWorkspaceSession(
        req.user._id.toString(),
        workspaceId,
        { title },
      );
      res.status(201).json({
        message: "Workspace planning session created",
        data: { session },
      });
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };

  public getWorkspaceSession = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const rawWsId =
        (req.query.workspaceId as string) || (req.params as any)?.workspaceId;
      const workspaceId =
        typeof rawWsId === "string" && rawWsId.trim()
          ? rawWsId.trim()
          : undefined;
      const sessionId = getParam(req.params.sessionId);
      const result = await aiPlanningService.getWorkspaceSession(
        req.user._id.toString(),
        workspaceId,
        sessionId,
      );
      res
        .status(200)
        .json({ message: "Workspace session details fetched", data: result });
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };

  public deleteWorkspaceSession = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const rawWsId =
        (req.query.workspaceId as string) || (req.params as any)?.workspaceId;
      const workspaceId =
        typeof rawWsId === "string" && rawWsId.trim()
          ? rawWsId.trim()
          : undefined;
      const sessionId = getParam(req.params.sessionId);
      await aiPlanningService.deleteWorkspaceSession(
        req.user._id.toString(),
        workspaceId,
        sessionId,
      );
      res
        .status(200)
        .json({ message: "Workspace session deleted successfully" });
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };

  public listSessions = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      sessions: await aiPlanningService.listSessions(userId, projectId),
    }));
  };

  public createSession = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(
      req,
      res,
      async (userId, projectId) => ({
        session: await aiPlanningService.createSession(
          userId,
          projectId,
          req.body as { title?: unknown },
        ),
      }),
      201,
    );
  };

  public getSession = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      workspace: await aiPlanningService.getSession(
        userId,
        projectId,
        getParam(req.params.sessionId),
      ),
    }));
  };

  public sendMessage = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(
      req,
      res,
      async (userId, projectId) => ({
        messages: await aiPlanningService.sendMessage(
          userId,
          projectId,
          getParam(req.params.sessionId),
          req.body as { content?: unknown },
        ),
      }),
      201,
    );
  };

  public createDraft = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(
      req,
      res,
      async (userId, projectId) => ({
        draft: await aiPlanningService.createDraft(
          userId,
          projectId,
          getParam(req.params.sessionId),
        ),
      }),
      201,
    );
  };

  public approveDraft = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      draft: await aiPlanningService.approveDraft(
        userId,
        projectId,
        getParam(req.params.draftId),
      ),
    }));
  };

  public rejectDraft = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    await this.handle(req, res, async (userId, projectId) => ({
      draft: await aiPlanningService.rejectDraft(
        userId,
        projectId,
        getParam(req.params.draftId),
        req.body as { reason?: unknown },
      ),
    }));
  };

  private async handle(
    req: AuthenticatedRequest,
    res: Response,
    operation: (
      userId: string,
      projectId: string,
    ) => Promise<Record<string, unknown>>,
    status = 200,
  ): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      await projectService.assertProjectPermission(
        req.user._id.toString(),
        getParam(req.params.projectId),
        "aiPlanner",
      );
      const data = await operation(
        req.user._id.toString(),
        getParam(req.params.projectId),
      );
      res
        .status(status)
        .json({ message: "AI planning request completed", data });
    } catch (error) {
      const statusCode = (error as { status?: number }).status ?? 500;
      res.status(statusCode).json({ error: (error as Error).message });
    }
  }
}

export default new AiPlanningController();
