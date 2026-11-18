import { Request, Response } from "express";

import type { IUserDocument } from "../../auth/models/user.model.js";
import type { ProjectPayload } from "../services/project.service.js";
import projectService from "../services/project.service.js";
import activityLogService from "../../audit/services/activity-log.service.js";

type AuthenticatedRequest = Request & { user?: IUserDocument };

import { parsePermissionPatch } from "../project-permissions.js";

const getRouteParam = (value: string | string[] | undefined): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return "";
};

class ProjectController {
  public createProject = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const workspaceId =
        (req.body as ProjectPayload)?.workspaceId ||
        (req.headers["x-workspace-id"] as string) ||
        (req.query.workspaceId as string) ||
        undefined;

      const project = await projectService.createProject(user._id.toString(), {
        ...(req.body as ProjectPayload),
        workspaceId,
      });

      res.status(201).json({
        message: "Project created",
        data: { project },
      });

      void activityLogService.logActivity({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        entityName: project.name,
        action: "created",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `created project "${project.name}"`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getProjects = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const search = req.query.search as string | undefined;

      const result = await projectService.fetchProjectsPaginated(
        user._id.toString(),
        page,
        limit,
        search,
      );

      res.status(200).json({
        message: "Project list fetched",
        data: result,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getProject = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const projectId = req.params.id as string;
      if (!/^[a-f0-9]{24}$/i.test(projectId)) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const project = await projectService.getProjectForUser(
        user._id.toString(),
        projectId,
      );
      res.status(200).json({ message: "Project fetched", data: { project } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateProject = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.id);
      const project = await projectService.updateProject(
        projectId,
        user._id.toString(),
        req.body as ProjectPayload,
      );

      res.status(200).json({
        message: "Project updated",
        data: { project },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "project",
        entityId: projectId,
        entityName: project.name,
        action: "updated",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `updated project "${project.name}"`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public deleteProject = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const projectId = getRouteParam(req.params.id);
      await projectService.deleteProject(projectId, user._id.toString());

      res.status(200).json({
        message: "Project deleted",
        data: { projectId },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "deleted",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `deleted a project`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public bulkDeleteProjects = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const { projectIds } = req.body as { projectIds: string[] };

      if (!Array.isArray(projectIds) || projectIds.length === 0) {
        res.status(400).json({ error: "Project IDs are required" });
        return;
      }

      const deletedCount = await projectService.bulkDeleteProjects(
        user._id.toString(),
        projectIds,
      );

      res.status(200).json({
        message: "Projects deleted",
        data: { deletedCount },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getMembers = async (
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
      const members = await projectService.fetchProjectMembers(
        user._id.toString(),
        projectId,
      );

      res.status(200).json({
        message: "Project members fetched",
        data: { members },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public addMember = async (
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
      const member = await projectService.addProjectMember(
        user._id.toString(),
        projectId,
        req.body as { userId?: unknown },
      );

      res.status(201).json({
        message: "Project member added",
        data: { member },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "member_added",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `added a member to the project`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateMemberPermissions = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const member = await projectService.updateMemberPermissions(
        user._id.toString(),
        getRouteParam(req.params.projectId),
        getRouteParam(req.params.userId),
        parsePermissionPatch(req.body),
      );
      res.status(200).json({
        message: "Member permissions updated",
        data: { member },
      });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public removeMember = async (
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
      const targetUserId = getRouteParam(req.params.userId);
      await projectService.removeProjectMember(
        user._id.toString(),
        projectId,
        targetUserId,
      );

      res.status(200).json({
        message: "Project member removed",
        data: { userId: targetUserId },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "member_removed",
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `removed a member from the project`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public leaveProject = async (
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
      await projectService.leaveProject(user._id.toString(), projectId);

      res.status(200).json({
        message: "You have left the project",
        data: { projectId },
      });

      void activityLogService.logActivity({
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "member_removed", // Reusing member_removed for simplicity
        userId: user._id.toString(),
        userName:
          user.name ||
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          "Unknown",
        description: `left the project`,
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

export default new ProjectController();
