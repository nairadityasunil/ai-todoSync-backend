import type { Response } from "express";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import activityLogService from "../services/activity-log.service.js";
import type { EntityType } from "../models/activity-log.model.js";

class ActivityLogController {
  public getActivities = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const projectId =
        typeof req.params.projectId === "string" ? req.params.projectId : "";
      const limitStr =
        typeof req.query.limit === "string" ? req.query.limit : undefined;
      const pageStr =
        typeof req.query.page === "string" ? req.query.page : undefined;
      const entityTypeStr =
        typeof req.query.entityType === "string"
          ? req.query.entityType
          : undefined;

      const result = await activityLogService.getProjectActivities(projectId, {
        limit: limitStr ? parseInt(limitStr, 10) : 50,
        page: pageStr ? parseInt(pageStr, 10) : 1,
        entityType: entityTypeStr as EntityType | undefined,
        entityIds:
          typeof req.query.entityIds === "string"
            ? req.query.entityIds.split(",").filter(Boolean).slice(0, 200)
            : undefined,
        userId:
          typeof req.query.userId === "string" ? req.query.userId : undefined,
        actor:
          req.query.actor === "agent" || req.query.actor === "person"
            ? req.query.actor
            : undefined,
        since: parseDate(req.query.since),
        until: parseDate(req.query.until),
      });

      res.json(result);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getRetentionPolicy = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const projectId =
        typeof req.params.projectId === "string" ? req.params.projectId : "";
      const policy = await activityLogService.getRetentionPolicy(projectId);
      res.json({ message: "Audit retention policy fetched", data: { policy } });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateRetentionPolicy = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId =
        typeof req.params.projectId === "string" ? req.params.projectId : "";
      const policy = await activityLogService.updateRetentionPolicy(
        projectId,
        user._id.toString(),
        req.body as { retentionDays?: unknown; legalHold?: unknown },
      );
      res.json({ message: "Audit retention policy updated", data: { policy } });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public verifyAuditChain = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const projectId =
        typeof req.params.projectId === "string" ? req.params.projectId : "";
      const verification = await activityLogService.verifyAuditChain(projectId);
      res.json({ message: "Audit chain verified", data: { verification } });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

const activityLogController = new ActivityLogController();
export default activityLogController;

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
