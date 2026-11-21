import type { Request, Response } from "express";

import type { IUserDocument } from "../../auth/models/user.model.js";
import priorityEngineService from "../services/priority-engine.service.js";
import projectService from "../../project/services/project.service.js";
import ProjectMemberModel from "../../project/models/project-member.model.js";
import TaskModel from "../models/task.model.js";

type AuthenticatedRequest = Request & { user?: IUserDocument };

class PriorityEngineController {
  public evaluateTask = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId =
        typeof req.params.taskId === "string" ? req.params.taskId : "";
      if (taskId) {
        const task = await TaskModel.findById(taskId)
          .select("projectId")
          .lean();
        if (task?.projectId) {
          await projectService.assertProjectRole(
            user._id.toString(),
            task.projectId.toString(),
            "ADMIN",
          );
        }
      }

      const evaluation = await priorityEngineService.evaluateTaskForUser(
        taskId,
        user._id.toString(),
      );
      res.json({
        message: "Priority evaluation complete",
        data: { evaluation },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public recalculate = async (
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
        typeof req.query.projectId === "string"
          ? req.query.projectId
          : typeof req.body?.projectId === "string"
            ? req.body.projectId
            : undefined;

      if (projectId) {
        await projectService.assertProjectRole(
          user._id.toString(),
          projectId,
          "ADMIN",
        );
      } else {
        const hasAdminRole = await ProjectMemberModel.exists({
          userId: user._id,
          role: "ADMIN",
        });
        if (!hasAdminRole) {
          res.status(403).json({
            error: "Only project admins can recalculate priorities",
          });
          return;
        }
      }

      const evaluations = await priorityEngineService.recalculateForUser(
        user._id.toString(),
      );
      res.json({
        message: "Dynamic priority recalculated",
        data: { count: evaluations.length, evaluations },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

export default new PriorityEngineController();
