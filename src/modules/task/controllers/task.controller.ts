import { Request, Response } from "express";

import type { IUserDocument } from "../../auth/models/user.model.js";
import type { ISubtask, TaskPriority } from "../models/task.model.js";
import type {
  CreateTaskPayload,
  UpdateTaskPayload,
  BulkAssignTasksPayload,
} from "../../../modules/task/repositories/task.repository.js";
import taskService from "../services/task.service.js";
import activityLogService from "../../audit/services/activity-log.service.js";

type AuthenticatedRequest = Request & { user?: IUserDocument };

interface CreateTaskRequestBody {
  title?: string;
  description?: string;
  note?: string;
  date?: string;
  status?: CreateTaskPayload["status"];
  priority?: TaskPriority;
  source?: string;
  projectId?: string | null;
  epicId?: string | null;
  subtasks?: ISubtask[];
  assignedTo?: string;
  /** A workflow state of the project; the status follows its category. */
  stateId?: string | null;
}

interface AssignTaskRequestBody {
  userId?: string | null;
}

const getDateQuery = (req: Request): string | undefined => {
  const { date } = req.query;

  if (typeof date === "string") {
    return date;
  }

  if (Array.isArray(date)) {
    return date.find((value): value is string => typeof value === "string");
  }

  return undefined;
};

const getRouteParam = (value: string | string[] | undefined): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return "";
};

class TaskController {
  public getTasks = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const tasks = await taskService.fetchTasks(
        user._id.toString(),
        getDateQuery(req),
        req.query.assigneeId as string | undefined,
        req.query.search as string | undefined,
      );

      res.status(200).json({
        message: "Task list fetched",
        data: { tasks },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getTasksAssignedToMe = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const tasks = await taskService.getTasksAssignedToMe(user._id.toString());

      res.status(200).json({
        message: "Assigned tasks list fetched",
        data: { tasks },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public createTask = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const {
        title,
        description,
        note,
        date,
        status,
        priority,
        source,
        projectId,
        epicId,
        subtasks,
        assignedTo,
        stateId,
      } = req.body as CreateTaskRequestBody;
      const payload: CreateTaskPayload = {
        userId: user._id.toString(),
        title: title ?? "",
        description,
        note,
        date,
        status,
        priority,
        source,
        projectId,
        epicId,
        subtasks,
        assignedTo: assignedTo || user._id.toString(),
        ...(stateId ? { stateId } : {}),
      } as CreateTaskPayload;
      const task = await taskService.createTask(payload);

      res.status(201).json({
        message: "Task created",
        data: { task },
      });

      if (task.projectId) {
        void activityLogService.logActivity({
          projectId: task.projectId,
          entityType: "task",
          entityId: task.id,
          entityName: task.title,
          action: "created",
          userId: user._id.toString(),
          userName:
            user.name ||
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
            "Unknown",
          description: `created task "${task.title}"`,
        });
      }
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  private noteHandler =
    (
      run: (
        taskId: string,
        noteId: string,
        userId: string,
        text: unknown,
      ) => Promise<unknown>,
      status = 200,
    ) =>
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const user = req.user;
        if (user == null) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        const task = await run(
          getRouteParam(req.params.id),
          getRouteParam(req.params.noteId),
          user._id.toString(),
          (req.body as { text?: unknown } | undefined)?.text,
        );
        res
          .status(status)
          .json({ message: "Task notes updated", data: { task } });
      } catch (error) {
        const code = (error as { status?: number }).status ?? 500;
        res.status(code).json({ error: (error as Error).message });
      }
    };

  public addNote = this.noteHandler(
    (taskId, _noteId, userId, text) =>
      taskService.addTaskNote(taskId, userId, text),
    201,
  );

  public updateNote = this.noteHandler((taskId, noteId, userId, text) =>
    taskService.updateTaskNote(taskId, noteId, userId, text),
  );

  public deleteNote = this.noteHandler((taskId, noteId, userId) =>
    taskService.deleteTaskNote(taskId, noteId, userId),
  );

  public updateTask = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const updates = req.body as UpdateTaskPayload;
      const taskId = getRouteParam(req.params.id);
      const updated = await taskService.updateTask(
        taskId,
        user._id.toString(),
        updates,
      );

      res.status(200).json({
        message: "Task updated",
        data: { task: updated },
      });

      if (updated.projectId) {
        void activityLogService.logActivity({
          projectId: updated.projectId,
          entityType: "task",
          entityId: taskId,
          entityName: updated.title,
          action: "updated",
          userId: user._id.toString(),
          userName:
            user.name ||
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
            "Unknown",
          description: `updated task "${updated.title}"`,
        });
      }
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public deleteTask = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId = getRouteParam(req.params.id);
      await taskService.deleteTask(taskId, user._id.toString());

      res.status(200).json({
        message: "Task deleted",
        data: { taskId },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public assignTask = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId = getRouteParam(req.params.id);
      const task = await taskService.assignTask(
        taskId,
        user._id.toString(),
        req.body as AssignTaskRequestBody,
      );

      res.status(200).json({
        message: "Task assignment updated",
        data: { task },
      });

      if (task.projectId) {
        void activityLogService.logActivity({
          projectId: task.projectId,
          entityType: "task",
          entityId: task.id,
          entityName: task.title,
          action: "assigned",
          userId: user._id.toString(),
          userName:
            user.name ||
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
            "Unknown",
          description: `assigned task "${task.title}" to ${task.assignedTo.name || task.assignedTo.email}`,
        });
      }
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public reassignTask = this.assignTask;

  public bulkAssignTasks = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const tasks = await taskService.bulkAssignTasks(
        user._id.toString(),
        req.body as BulkAssignTasksPayload,
      );

      res.status(200).json({
        message: `${tasks.length} tasks assigned successfully`,
        data: { tasks },
      });

      // Log activity for each task
      for (const task of tasks) {
        if (task.projectId) {
          void activityLogService.logActivity({
            projectId: task.projectId,
            entityType: "task",
            entityId: task.id,
            entityName: task.title,
            action: "assigned",
            userId: user._id.toString(),
            userName:
              user.name ||
              [user.firstName, user.lastName].filter(Boolean).join(" ") ||
              "Unknown",
            description: `bulk assigned task "${task.title}" to ${task.assignedTo.name || task.assignedTo.email}`,
          });
        }
      }
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateTaskStatus = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId = getRouteParam(req.params.id);
      const { status } = req.body;
      const task = await taskService.updateTask(taskId, user._id.toString(), {
        status,
      });

      res.status(200).json({
        message: "Task status updated",
        data: { task },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public markTaskBlocked = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId = getRouteParam(req.params.id);
      const { blockedByTaskId } = req.body;
      const task = await taskService.markTaskBlocked(
        taskId,
        user._id.toString(),
        blockedByTaskId,
      );

      res.status(200).json({
        message: "Task marked as blocked",
        data: { task },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public unblockTask = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId = getRouteParam(req.params.id);
      const task = await taskService.unblockTask(taskId, user._id.toString());

      res.status(200).json({
        message: "Task unblocked",
        data: { task },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public taskSummary = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const summary = await taskService.getSummary(
        user._id.toString(),
        getDateQuery(req),
      );

      res.status(200).json({
        message: "Task summary generated",
        data: { summary },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

export default new TaskController();
