import type { Request, Response } from "express";

import type { IUserDocument } from "../../auth/models/user.model.js";
import slaService from "../services/sla.service.js";

type AuthenticatedRequest = Request & { user?: IUserDocument };

const getRouteParam = (value: string | string[] | undefined): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return "";
};

class SlaController {
  public getConfigs = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const configs = await slaService.getConfigs(user._id.toString());
      res
        .status(200)
        .json({ message: "SLA config fetched", data: { configs } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateConfig = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const config = await slaService.updateConfig(
        user._id.toString(),
        req.body,
      );
      res.status(200).json({ message: "SLA config updated", data: { config } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getProjectConfigs = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { enabled, configs } = await slaService.getProjectSla(
        user._id.toString(),
        getRouteParam(req.params.projectId),
      );
      res
        .status(200)
        .json({ message: "Project SLA fetched", data: { configs, enabled } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public setProjectEnabled = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const result = await slaService.setProjectSlaEnabled(
        user._id.toString(),
        getRouteParam(req.params.projectId),
        (req.body as { enabled?: unknown } | undefined)?.enabled,
      );
      res
        .status(200)
        .json({ message: "Project SLA tracking updated", data: result });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateProjectConfig = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const config = await slaService.updateProjectConfig(
        user._id.toString(),
        getRouteParam(req.params.projectId),
        req.body ?? {},
      );
      res
        .status(200)
        .json({ message: "Project SLA updated", data: { config } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public resetProjectConfig = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      await slaService.resetProjectConfig(
        user._id.toString(),
        getRouteParam(req.params.projectId),
        getRouteParam(req.params.priority),
      );
      res.status(200).json({ message: "Project SLA reset to defaults" });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getTaskStatus = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const status = await slaService.getTaskStatus(
        getRouteParam(req.params.taskId),
        user._id.toString(),
      );
      res.status(200).json({ message: "SLA status fetched", data: { status } });
    } catch (error) {
      const httpStatus = (error as any).status || 500;
      res.status(httpStatus).json({ error: (error as Error).message });
    }
  };

  public getBreachedTasks = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const tasks = await slaService.listBreachedTasks(user._id.toString());
      res.status(200).json({
        message: "Breached tasks fetched",
        data: {
          tasks: tasks.map((task) => ({
            id: task._id.toString(),
            title: task.title,
            priority: task.priority,
            status: task.status,
            responseBreached: task.responseBreached,
            resolutionBreached: task.resolutionBreached,
            slaResponseDueAt: task.slaResponseDueAt?.toISOString() ?? null,
            slaResolutionDueAt: task.slaResolutionDueAt?.toISOString() ?? null,
            currentSlaState: task.currentSlaState,
          })),
        },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getAnalytics = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const one = (v: unknown): string | undefined =>
        typeof v === "string" && v ? v : undefined;
      const summary = await slaService.getAnalytics(user._id.toString(), {
        projectId: one(req.query.projectId),
        workspaceId: one(req.query.workspaceId),
      });
      res
        .status(200)
        .json({ message: "SLA analytics fetched", data: { summary } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

export default new SlaController();
