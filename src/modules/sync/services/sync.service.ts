import {
  SyncTaskInsertPayload,
  bulkInsertTasks,
} from "../../../modules/sync/repositories/sync.repository.js";
import type {
  ISubtask,
  ITaskDocument,
  TaskStatus,
  TaskWorkflowStatus,
} from "../../../modules/task/models/task.model.js";
import projectService from "../../project/services/project.service.js";
import epicService from "../../epic/services/epic.service.js";
import { formatLocalDate } from "../../../utils/date.js";

interface SyncSubtaskResult {
  id: string;
  title: string;
  description?: string;
  note?: string;
  status: TaskWorkflowStatus;
  completed: boolean;
  completedAt: Date | null;
}

interface SyncTaskInput {
  title: string;
  description?: string;
  note?: string;
  status?: TaskStatus;
  source?: string;
  project?: unknown;
  epic?: unknown;
  subtasks?: ISubtask[];
}

interface SyncRequestBody {
  tasks?: unknown;
  date?: unknown;
  source?: unknown;
}

interface SyncSingleRequestBody {
  title?: unknown;
  description?: unknown;
  status?: TaskStatus;
  source?: unknown;
  date?: unknown;
  project?: unknown;
  epic?: unknown;
}

interface SyncTaskResult {
  id: string;
  title: string;
  description?: string;
  note?: string;
  date: string;
  status: TaskStatus;
  source?: string;
  projectId: string | null;
  epicId: string | null;
  subtasks: SyncSubtaskResult[];
}

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class SyncService {
  private static readonly MAX_TASKS_PER_SYNC = 100;

  public async syncTasks(
    userId: string,
    payload: SyncRequestBody,
  ): Promise<SyncTaskResult[]> {
    const { date, source } = this.normalizeContext(
      payload.date,
      payload.source,
    );
    const tasks = this.parseTasks(payload.tasks);

    if (tasks.length === 0) {
      throw new HttpError(400, "At least one task is required");
    }

    if (tasks.length > SyncService.MAX_TASKS_PER_SYNC) {
      throw new HttpError(
        413,
        `Cannot sync more than ${SyncService.MAX_TASKS_PER_SYNC} tasks at once`,
      );
    }

    const inserts = await Promise.all(
      tasks.map((task) => this.buildInsertPayload(userId, date, source, task)),
    );

    const created = await bulkInsertTasks(inserts);
    return created.map((task) => this.toResult(task));
  }

  public async syncSingleTask(
    userId: string,
    payload: SyncSingleRequestBody,
  ): Promise<SyncTaskResult> {
    const { date, source } = this.normalizeContext(
      payload.date,
      payload.source,
    );
    const task = this.parseTaskInput(payload);

    const insert = await this.buildInsertPayload(userId, date, source, task);
    const [created] = await bulkInsertTasks([insert]);

    return this.toResult(created);
  }

  private normalizeContext(
    dateValue: unknown,
    sourceValue: unknown,
  ): {
    date: string;
    source?: string;
  } {
    const resolvedDate = this.resolveDate(dateValue);
    const resolvedSource =
      typeof sourceValue === "string" ? sourceValue : undefined;
    return { date: resolvedDate, source: resolvedSource };
  }

  private resolveDate(value: unknown): string {
    if (typeof value === "string" && this.isValidDate(value)) {
      return value;
    }

    return formatLocalDate();
  }

  private parseTasks(value: unknown): SyncTaskInput[] {
    if (!Array.isArray(value)) {
      throw new HttpError(400, "`tasks` must be an array");
    }

    return value.map((item) => this.parseTaskInput(item));
  }
  private parseTaskInput(value: unknown): SyncTaskInput {
    if (value == null || typeof value !== "object") {
      throw new HttpError(400, "Each task must be an object");
    }

    const task = value as Record<string, unknown>;
    const title = typeof task.title === "string" ? task.title.trim() : "";
    if (!title) {
      throw new HttpError(400, "Task title is required");
    }

    const description =
      typeof task.description === "string" ? task.description : undefined;
    const note = typeof task.note === "string" ? task.note.trim() : undefined;
    const status = this.parseStatus(task.status);
    const source = typeof task.source === "string" ? task.source : undefined;
    const project = task.project;
    const epic = task.epic;
    const subtasks = this.parseSubtasks(task.subtasks);

    return {
      title,
      description,
      note,
      status,
      source,
      project,
      epic,
      subtasks,
    };
  }

  private parseStatus(value: unknown): TaskStatus | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (
      value === "pending" ||
      value === "TODO" ||
      value === "in_progress" ||
      value === "IN_PROGRESS" ||
      value === "in_review" ||
      value === "IN_REVIEW" ||
      value === "completed" ||
      value === "done" ||
      value === "DONE" ||
      value === "BACKLOG" ||
      value === "BLOCKED"
    ) {
      if (value === "done" || value === "completed" || value === "DONE") {
        return "DONE";
      }
      if (value === "pending" || value === "TODO") {
        return "TODO";
      }
      if (value === "in_progress" || value === "IN_PROGRESS") {
        return "IN_PROGRESS";
      }
      if (value === "in_review" || value === "IN_REVIEW") {
        return "IN_REVIEW";
      }
      return value as TaskStatus;
    }

    if (value === "rolled_over") {
      return value;
    }

    throw new HttpError(400, "Invalid status value");
  }

  private async buildInsertPayload(
    userId: string,
    date: string,
    source: string | undefined,
    task: SyncTaskInput,
  ): Promise<SyncTaskInsertPayload> {
    const projectId = await projectService.resolveProjectForSync(
      userId,
      task.project,
    );
    const epicId = await this.resolveEpicForSync(projectId, task.epic);

    return {
      userId,
      title: task.title,
      description: task.description,
      note: task.note,
      date,
      status: task.status,
      source: task.source ?? source,
      projectId,
      epicId,
      subtasks: task.subtasks,
    };
  }

  private toResult(task: ITaskDocument): SyncTaskResult {
    return {
      id: task._id.toString(),
      title: task.title,
      description: task.description,
      note: task.note,
      date: task.date ?? "",
      status: this.normalizeStoredTaskStatus(task.status),
      source: task.source,
      projectId: task.projectId?.toString() ?? null,
      epicId: task.epicId?.toString() ?? null,
      subtasks: this.toSubtaskResults(task.subtasks),
    };
  }

  private async resolveEpicForSync(
    projectId: string | null | undefined,
    epicValue: unknown,
  ): Promise<string | null | undefined> {
    if (epicValue === undefined) {
      return undefined;
    }

    if (epicValue === null || epicValue === "") {
      return null;
    }

    if (typeof epicValue !== "string") {
      throw new HttpError(400, "Invalid epic value");
    }

    if (projectId == null) {
      throw new HttpError(400, "Epic sync requires a project");
    }

    const epic = await epicService.assertEpicInProject(projectId, epicValue);
    return epic.id;
  }

  private parseSubtasks(value: unknown): ISubtask[] | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value)) {
      throw new HttpError(400, "Subtasks must be an array");
    }

    return value.map((subtask, index) => this.parseSubtask(subtask, index));
  }

  private parseSubtask(value: unknown, index: number): ISubtask {
    if (value == null || typeof value !== "object") {
      throw new HttpError(400, `Subtask at index ${index} must be an object`);
    }

    const subtask = value as Record<string, unknown>;
    const title = typeof subtask.title === "string" ? subtask.title.trim() : "";
    const description =
      typeof subtask.description === "string"
        ? subtask.description.trim()
        : undefined;
    const note = typeof subtask.note === "string" ? subtask.note.trim() : "";

    if (!title) {
      throw new HttpError(400, `Subtask at index ${index} requires a title`);
    }

    const status = this.parseWorkflowStatus(subtask.status, subtask.completed);
    const completed = status === "DONE";
    const completedAt = completed
      ? this.parseCompletedAt(subtask.completedAt)
      : null;

    return {
      title,
      description,
      note,
      status,
      completed,
      completedAt,
    };
  }

  private parseWorkflowStatus(
    statusValue: unknown,
    completedValue: unknown,
  ): TaskWorkflowStatus {
    if (
      statusValue === "done" ||
      statusValue === "DONE" ||
      statusValue === "completed"
    ) {
      return "DONE";
    }

    if (
      statusValue === "pending" ||
      statusValue === "TODO" ||
      statusValue === "in_progress" ||
      statusValue === "IN_PROGRESS" ||
      statusValue === "in_review" ||
      statusValue === "IN_REVIEW" ||
      statusValue === "BACKLOG" ||
      statusValue === "BLOCKED"
    ) {
      if (statusValue === "pending" || statusValue === "TODO") return "TODO";
      if (statusValue === "in_progress" || statusValue === "IN_PROGRESS")
        return "IN_PROGRESS";
      if (statusValue === "in_review" || statusValue === "IN_REVIEW")
        return "IN_REVIEW";
      return statusValue as TaskWorkflowStatus;
    }

    if (typeof completedValue === "boolean") {
      return completedValue ? "DONE" : "TODO";
    }

    return "TODO";
  }

  private parseCompletedAt(value: unknown): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }

    if (typeof value === "string") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }

    return new Date();
  }

  private toSubtaskResults(subtasks?: ISubtask[]): SyncSubtaskResult[] {
    return (subtasks ?? []).map((subtask) => ({
      id: this.getSubtaskId(subtask),
      title: subtask.title,
      description: subtask.description,
      note: subtask.note,
      status: subtask.status,
      completed: subtask.completed,
      completedAt: subtask.completedAt ?? null,
    }));
  }

  private getSubtaskId(subtask: ISubtask): string {
    const subtaskWithId = subtask as ISubtask & { _id?: unknown };
    return subtaskWithId._id != null ? String(subtaskWithId._id) : "";
  }

  private normalizeStoredTaskStatus(status: string): TaskStatus {
    if (status === "done" || status === "completed" || status === "DONE") {
      return "DONE";
    }
    if (status === "pending" || status === "TODO") {
      return "TODO";
    }
    return status as TaskStatus;
  }

  private isValidDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
  }
}

const syncService = new SyncService();
export type { SyncTaskResult };
export default syncService;
