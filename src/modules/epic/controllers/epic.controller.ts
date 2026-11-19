import { Request, Response } from "express";

import type { IUserDocument } from "../../auth/models/user.model.js";
import type { EpicPayload } from "../services/epic.service.js";
import epicService from "../services/epic.service.js";
import activityLogService from "../../audit/services/activity-log.service.js";

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

class EpicController {
  public createEpic = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.projectId);
      const epic = await epicService.createEpic(
        user._id.toString(),
        projectId,
        req.body as EpicPayload,
      );

      res.status(201).json({
        message: "Epic created",
        data: { epic },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "epic",
        entityId: epic.id,
        entityName: epic.name,
        action: "created",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `created epic "${epic.name}"`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  /** GET /api/epics : the epics of every project the caller belongs to. `?projectId=` narrows it to one project. */
  public getMyEpics = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const projectId =
        typeof req.query.projectId === "string" && req.query.projectId.trim()
          ? req.query.projectId.trim()
          : undefined;
      const workspaceId =
        typeof req.query.workspaceId === "string" &&
        req.query.workspaceId.trim()
          ? req.query.workspaceId.trim()
          : undefined;
      const epics = await epicService.fetchMyEpics(
        user._id.toString(),
        projectId,
        workspaceId,
      );
      res.status(200).json({ message: "Epic list fetched", data: { epics } });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getEpics = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.projectId);
      const epics = await epicService.fetchProjectEpics(
        user._id.toString(),
        projectId,
      );

      res.status(200).json({
        message: "Epic list fetched",
        data: { epics },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateEpic = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.projectId);
      const epicId = getRouteParam(req.params.epicId);
      const epic = await epicService.updateEpic(
        user._id.toString(),
        projectId,
        epicId,
        req.body as EpicPayload,
      );

      res.status(200).json({
        message: "Epic updated",
        data: { epic },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "epic",
        entityId: epicId,
        entityName: epic.name,
        action: "updated",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `updated epic "${epic.name}"`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public deleteEpic = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.projectId);
      const epicId = getRouteParam(req.params.epicId);
      await epicService.deleteEpic(user._id.toString(), projectId, epicId);

      res.status(200).json({
        message: "Epic deleted",
        data: { epicId },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "epic",
        entityId: epicId,
        action: "deleted",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `deleted an epic`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public reorderEpics = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.projectId);
      const epics = await epicService.reorderProjectEpics(
        user._id.toString(),
        projectId,
        req.body as { epicIds?: unknown },
      );

      res.status(200).json({
        message: "Epics reordered",
        data: { epics },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

export default new EpicController();
