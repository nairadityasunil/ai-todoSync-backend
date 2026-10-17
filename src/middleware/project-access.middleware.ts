import type { NextFunction, Response } from "express";

import type { ProjectRole } from "../interfaces/project/project.interface.js";
import projectService from "../modules/project/services/project.service.js";
import type { AuthenticatedRequest } from "../types/auth.js";

const getProjectIdFromRequest = (
  req: AuthenticatedRequest,
): string | undefined => {
  const routeValue = req.params.projectId ?? req.params.id;

  if (typeof routeValue === "string") {
    const normalized = routeValue.trim();
    return normalized === "" ? undefined : normalized;
  }

  if (Array.isArray(routeValue)) {
    const normalized = routeValue.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
    return normalized?.trim();
  }

  return undefined;
};

export const isProjectMember = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = req.user;

    if (user == null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const projectId = getProjectIdFromRequest(req);

    if (projectId == null) {
      res.status(400).json({ error: "Project id is required" });
      return;
    }

    req.projectAccess = await projectService.getProjectAccess(
      user._id.toString(),
      projectId,
    );

    const resolvedObjectId = req.projectAccess.project._id.toString();
    if (req.params.projectId) {
      req.params.projectId = resolvedObjectId;
    }
    if (
      req.params.id &&
      (req.params.id === projectId ||
        req.params.id === req.projectAccess.project.uuid)
    ) {
      req.params.id = resolvedObjectId;
    }

    next();
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    res.status(status).json({ error: (error as Error).message });
  }
};

export const requireProjectRole =
  (requiredRole: ProjectRole) =>
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      if (req.projectAccess == null) {
        await isProjectMember(req, res, async () => undefined);
      }

      if (res.headersSent) {
        return;
      }

      const access = req.projectAccess;

      if (access == null) {
        res.status(403).json({ error: "Project access denied" });
        return;
      }

      const roleOrder: Record<ProjectRole, number> = {
        MEMBER: 1,
        ADMIN: 2,
      };

      if (roleOrder[access.role] < roleOrder[requiredRole]) {
        res.status(403).json({ error: "Insufficient project role" });
        return;
      }

      next();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
