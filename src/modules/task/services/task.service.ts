import mongoose from "mongoose";
import {
  createTask,
  deleteTask,
  getTaskByIdAndUser,
  getTasksByDate,
  getTasksByUser,
  updateTask,
  type CreateTaskPayload,
  type UpdateTaskPayload,
  type BulkAssignTasksPayload,
  taskPopulateOptions,
  type TaskDocumentWithAssignee,
} from "../../../modules/task/repositories/task.repository.js";
import type {
  ISubtask,
  TaskStatus,
  TaskWorkflowStatus,
  TaskPriority,
} from "../../../modules/task/models/task.model.js";
import type { ProjectRole } from "../../project/models/project-member.model.js";
import type { IUserDocument } from "../../auth/models/user.model.js";
import { getProjectMembershipsByUser } from "../../project/repositories/project-member.repository.js";
import projectService from "../../project/services/project.service.js";
import epicService from "../../epic/services/epic.service.js";
import chatSocketServer from "../../../socket/chat.socket.js";
import TaskModel from "../models/task.model.js";
import UserModel from "../../auth/models/user.model.js";
import ProjectMemberModel from "../../project/models/project-member.model.js";
import {
  andRefMatches,
  buildRefInMatch,
  buildRefMatch,
} from "../../../utils/mongo-ref.js";
import operationalAnalyticsService from "../../analytics/services/operational-analytics.service.js";
import slaService from "./sla.service.js";
import priorityEngineService from "./priority-engine.service.js";

/** Id of a reference that may or may not be populated. */
const refId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value ?? "");
};

const UPDATABLE_TASK_FIELDS = new Set([
  "title",
  "description",
  "note",
  "date",
  "status",
  "priority",
  "isBlocked",
  "blockedByTaskId",
  "order",
  "projectId",
  "epicId",
  "assignedTo",
  "subtasks",
  "estimatedHours",
]);

interface TaskUserDto {
  id: string;
  email: string;
  name: string | null;
}

interface SubtaskDto {
  id: string;
  title: string;
  note?: string;
  status: TaskWorkflowStatus;
  completed: boolean;
  completedAt: Date | null;
  assignedToUserId: string | null;
  assignedToUser: TaskUserDto | null;
}

interface TaskPermissionsDto {
  canEdit: boolean;
  canDelete: boolean;
  canAssign: boolean;
  canUpdate: boolean;
  canReassign: boolean;
}

interface TaskDto {
  id: string;
  userId: string;
  title: string;
  description?: string;
  note?: string;
  date: string;
  status: TaskStatus;
  priority: TaskPriority;
  basePriority: TaskPriority;
  dynamicPriority: TaskPriority;
  urgencyScore: number;
  impactScore: number;
  dependencyWeight: number;
  dynamicPriorityScore: number;
  priorityEscalatedAt: string | null;
  priorityEscalationReason: string;
  isBlocked: boolean;
  blockedByTaskId: string | null;
  order: number;
  rolledOver: boolean;
  rolloverCount: number;
  source?: string;
  projectId: string | null;
  epicId: string | null;
  assignedTo: TaskUserDto;
  assignedBy: TaskUserDto | null;
  assignedAt: string;
  subtasks: SubtaskDto[];
  slaResponseDueAt: string | null;
  slaResolutionDueAt: string | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
  firstResponseAt: string | null;
  completedAt: string | null;
  slaPausedAt: string | null;
  totalPausedDuration: number;
  currentSlaState: string;
  permissions: TaskPermissionsDto;
}

interface TaskSummary {
  total: number;
  backlog: number;
  todo: number;
  inProgress: number;
  inReview: number;
  blocked: number;
  done: number;
  rolledOver: number;
  date?: string;
}

interface AssignTaskPayload {
  userId?: unknown;
}

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class TaskService {
  public async createTask(payload: CreateTaskPayload): Promise<TaskDto> {
    if (
      payload.title == null ||
      payload.title === "" ||
      payload.date == null ||
      payload.date === ""
    ) {
      throw new HttpError(400, "Title and date are required");
    }

    payload.projectId = this.normalizeNullableId(payload.projectId);
    payload.epicId = this.normalizeNullableId(payload.epicId);

    if (payload.projectId) {
      await projectService.assertProjectRole(
        payload.userId,
        payload.projectId,
        "MEMBER",
      );
    }

    const resolved = await this.resolveEpicId(
      payload.projectId,
      payload.epicId,
      payload.userId,
    );

    payload.projectId = resolved.projectId;
    payload.epicId = resolved.epicId;

    payload.note = this.normalizeOptionalText(payload.note);

    if (payload.status != null) {
      payload.status = this.normalizeTaskStatus(payload.status);
    }

    payload.subtasks = this.normalizeSubtasks(payload.subtasks);
    payload.status = this.reconcileTaskStatusWithSubtasks(
      payload.status,
      payload.subtasks,
    );
    payload.subtasks = this.applyCompletedStatusToSubtasks(
      payload.status,
      payload.subtasks,
    );

    const now = new Date();
    const slaFields = await slaService.buildInitialSlaFields(
      payload.userId,
      payload.priority,
      payload.status,
      now,
    );

    const basePriority = payload.priority ?? "MEDIUM";
    const task = await createTask({
      ...payload,
      basePriority,
      dynamicPriority: basePriority,
      assignedTo: payload.assignedTo || payload.userId,
      assignedBy: payload.userId,
      assignedAt: now,
      ...slaFields,
    });

    operationalAnalyticsService.recordEventSafely({
      eventName: "task_created",
      entityType: "task",
      entityId: task._id.toString(),
      userId: payload.userId,
      projectId: task.projectId?.toString() ?? null,
      metadata: {
        status: task.status,
        priority: task.priority,
        assignedTo: task.assignedTo?.toString(),
        source: task.source,
      },
    });

    await priorityEngineService.evaluateAndPersist(task, payload.userId);

    return this.toDto(
      payload.userId,
      task,
      payload.projectId
        ? new Map([[payload.projectId, "ADMIN" as const]])
        : new Map(),
    );
  }

  public async fetchTasks(
    userId: string,
    date?: unknown,
    assigneeId?: string,
    search?: string,
  ): Promise<TaskDto[]> {
    const normalizedDate = this.normalizeDate(date);
    const memberships = await getProjectMembershipsByUser(userId);
    const projectIds = memberships.map((membership) =>
      membership.projectId.toString(),
    );
    const roleMap = this.buildRoleMap(memberships);
    const tasks = normalizedDate
      ? await getTasksByDate(
          userId,
          projectIds,
          normalizedDate,
          assigneeId,
          search,
        )
      : await getTasksByUser(userId, projectIds, assigneeId, search);
    return tasks.map((task) => this.toDto(userId, task, roleMap));
  }

  public async getTasksAssignedToMe(userId: string): Promise<TaskDto[]> {
    const memberships = await getProjectMembershipsByUser(userId);
    const projectIds = memberships.map((m) => m.projectId.toString());
    const roleMap = this.buildRoleMap(memberships);

    const tasks = await TaskModel.find(
      andRefMatches(
        buildRefMatch("assignedTo", userId),
        buildRefInMatch("projectId", projectIds),
      ),
    )
      .populate(taskPopulateOptions)
      .exec();

    return tasks.map((task) =>
      this.toDto(userId, task as TaskDocumentWithAssignee, roleMap),
    );
  }

  public async updateTask(
    taskId: string,
    userId: string,
    updates: UpdateTaskPayload,
  ): Promise<TaskDto> {
    const memberships = await getProjectMembershipsByUser(userId);
    const roleMap = this.buildRoleMap(memberships);
    const currentTask = await getTaskByIdAndUser(
      taskId,
      userId,
      Array.from(roleMap.keys()),
    );

    if (currentTask == null) {
      throw new HttpError(404, "Task not found");
    }

    const currentRole = currentTask.projectId
      ? (roleMap.get(currentTask.projectId.toString()) ?? null)
      : null;
    const permission = this.getTaskPermission(userId, currentTask, currentRole);

    if (permission.canUpdate === false) {
      throw new HttpError(403, "Task update not allowed");
    }

    // Only these fields are client-editable; ownership, SLA and priority
    // engine fields are server-managed.
    updates = Object.fromEntries(
      Object.entries(updates ?? {}).filter(([key]) =>
        UPDATABLE_TASK_FIELDS.has(key),
      ),
    ) as UpdateTaskPayload;

    if (
      updates.assignedTo !== undefined &&
      String(updates.assignedTo) !== refId(currentTask.assignedTo)
    ) {
      await this.assertCanReassign(
        userId,
        currentTask,
        permission,
        String(updates.assignedTo),
      );
    }

    const hasFullEditAccess = permission.canEdit;

    if (!hasFullEditAccess) {
      const disallowedFields = [
        "title",
        "description",
        "date",
        "projectId",
        "epicId",
      ];
      const attemptedRestrictedField = disallowedFields.some((field) =>
        Object.prototype.hasOwnProperty.call(updates, field),
      );

      if (attemptedRestrictedField) {
        throw new HttpError(
          403,
          "Assigned members can only update status, notes, and subtasks",
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, "projectId")) {
      updates.projectId = this.normalizeNullableId(updates.projectId);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "epicId")) {
      updates.epicId = this.normalizeNullableId(updates.epicId);
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, "projectId") &&
      updates.projectId
    ) {
      await projectService.assertProjectRole(
        userId,
        updates.projectId,
        "ADMIN",
      );
    }

    const nextProjectId = Object.prototype.hasOwnProperty.call(
      updates,
      "projectId",
    )
      ? (updates.projectId ?? null)
      : (currentTask.projectId?.toString() ?? null);

    updates.projectId = nextProjectId;
    updates.epicId = await this.resolveUpdatedEpicId(
      userId,
      currentTask.projectId?.toString() ?? null,
      currentTask.epicId?.toString() ?? null,
      nextProjectId,
      Object.prototype.hasOwnProperty.call(updates, "epicId")
        ? updates.epicId
        : undefined,
    );

    if (
      Object.prototype.hasOwnProperty.call(updates, "status") &&
      updates.status != null
    ) {
      updates.status = this.normalizeTaskStatus(updates.status);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "note")) {
      updates.note = this.normalizeOptionalText(updates.note);
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, "priority") &&
      updates.priority
    ) {
      updates.basePriority = updates.priority;
      updates.dynamicPriority = updates.priority;
    }

    if (Object.prototype.hasOwnProperty.call(updates, "subtasks")) {
      updates.subtasks = this.normalizeSubtasks(updates.subtasks);
    }

    if (updates.status === "DONE") {
      updates.subtasks = this.applyCompletedStatusToSubtasks(
        updates.status,
        updates.subtasks ?? currentTask.subtasks ?? [],
      );
    }

    if (updates.status === "BLOCKED" && !currentTask.isBlocked) {
      updates.isBlocked = true;
    }

    if (
      updates.status === "DONE" &&
      (currentTask.isBlocked || updates.isBlocked)
    ) {
      throw new HttpError(400, "Cannot complete a blocked task");
    }

    if (Object.prototype.hasOwnProperty.call(updates, "subtasks")) {
      updates.status = this.reconcileTaskStatusWithSubtasks(
        updates.status ?? this.normalizeStoredTaskStatus(currentTask.status),
        updates.subtasks ?? [],
      );
    }

    updates = await slaService.applyPriorityChange(
      userId,
      currentTask,
      updates,
    );
    updates = slaService.applyStatusTransition(currentTask, updates);

    const updated = await updateTask(taskId, updates);

    if (updated == null) {
      throw new HttpError(404, "Task not found");
    }

    this.recordTaskUpdateEvents(userId, currentTask, updated);
    await priorityEngineService.evaluateAndPersist(updated, userId);

    return this.toDto(userId, updated, roleMap);
  }

  public async assignTask(
    taskId: string,
    actorUserId: string,
    payload: AssignTaskPayload,
  ): Promise<TaskDto> {
    const memberships = await getProjectMembershipsByUser(actorUserId);
    const roleMap = this.buildRoleMap(memberships);
    const currentTask = await getTaskByIdAndUser(
      taskId,
      actorUserId,
      Array.from(roleMap.keys()),
    );

    if (currentTask == null) {
      throw new HttpError(404, "Task not found");
    }

    const currentRole = currentTask.projectId
      ? (roleMap.get(currentTask.projectId.toString()) ?? null)
      : null;
    const permission = this.getTaskPermission(
      actorUserId,
      currentTask,
      currentRole,
    );

    if (permission.canAssign === false) {
      throw new HttpError(403, "Task assignment not allowed");
    }

    const targetUserId = this.normalizeNullableId(payload.userId);
    if (!targetUserId) {
      throw new HttpError(400, "Target user ID is required");
    }

    const targetUser = await UserModel.findById(targetUserId);
    if (!targetUser) {
      throw new HttpError(404, "Target user not found");
    }

    if (currentTask.projectId) {
      // Both conditions use $expr, so they must be combined with $and:
      // spreading them would keep only the last one.
      const targetMembership = await ProjectMemberModel.findOne(
        andRefMatches(
          buildRefMatch("projectId", currentTask.projectId.toString()),
          buildRefMatch("userId", targetUserId),
        ),
      );
      if (!targetMembership) {
        throw new HttpError(400, "Target user is not a member of the project");
      }
    }

    const updated = await updateTask(taskId, {
      assignedTo: targetUserId,
      assignedBy: actorUserId,
      assignedAt: new Date(),
    });

    if (updated == null) {
      throw new HttpError(404, "Task not found");
    }

    const dto = this.toDto(actorUserId, updated, roleMap);
    operationalAnalyticsService.recordEventSafely({
      eventName: "task_assigned",
      entityType: "task",
      entityId: updated._id.toString(),
      userId: actorUserId,
      projectId: updated.projectId?.toString() ?? null,
      metadata: {
        previousAssigneeId: currentTask.assignedTo?.toString() ?? null,
        nextAssigneeId: targetUserId,
        assignedBy: actorUserId,
        transition: {
          before: { assignedTo: currentTask.assignedTo?.toString() ?? null },
          after: { assignedTo: targetUserId },
        },
      },
    });

    if (targetUserId !== actorUserId) {
      chatSocketServer.notifyUser(targetUserId, "task:assigned", {
        task: dto,
        assignedBy: actorUserId,
      });
    }

    return dto;
  }

  public async markTaskBlocked(
    taskId: string,
    userId: string,
    blockedByTaskId?: string,
  ): Promise<TaskDto> {
    const memberships = await getProjectMembershipsByUser(userId);
    const roleMap = this.buildRoleMap(memberships);
    const task = await getTaskByIdAndUser(
      taskId,
      userId,
      Array.from(roleMap.keys()),
    );

    if (task == null) {
      throw new HttpError(404, "Task not found");
    }

    if (blockedByTaskId) {
      const blockingTask = await TaskModel.findById(blockedByTaskId);
      if (!blockingTask) {
        throw new HttpError(400, "Blocking task not found");
      }
    }

    const updated = await updateTask(
      taskId,
      slaService.applyStatusTransition(task, {
        isBlocked: true,
        blockedByTaskId: blockedByTaskId || null,
        status: "BLOCKED",
      }),
    );

    if (!updated) throw new HttpError(404, "Task not found");

    operationalAnalyticsService.recordEventSafely({
      eventName: "task_blocked",
      entityType: "task",
      entityId: updated._id.toString(),
      userId,
      projectId: updated.projectId?.toString() ?? null,
      metadata: {
        action: "blocked",
        previousStatus: task.status,
        nextStatus: updated.status,
        blockedByTaskId: blockedByTaskId ?? null,
      },
    });

    await priorityEngineService.evaluateAndPersist(updated, userId);

    return this.toDto(userId, updated, roleMap);
  }

  public async unblockTask(taskId: string, userId: string): Promise<TaskDto> {
    const memberships = await getProjectMembershipsByUser(userId);
    const roleMap = this.buildRoleMap(memberships);
    const task = await getTaskByIdAndUser(
      taskId,
      userId,
      Array.from(roleMap.keys()),
    );

    if (task == null) {
      throw new HttpError(404, "Task not found");
    }

    const updated = await updateTask(
      taskId,
      slaService.applyStatusTransition(task, {
        isBlocked: false,
        blockedByTaskId: null,
        status: "TODO",
      }),
    );

    if (!updated) throw new HttpError(404, "Task not found");

    operationalAnalyticsService.recordEventSafely({
      eventName: "task_unblocked",
      entityType: "task",
      entityId: updated._id.toString(),
      userId,
      projectId: updated.projectId?.toString() ?? null,
      metadata: {
        action: "unblocked",
        previousStatus: task.status,
        nextStatus: updated.status,
      },
    });

    await priorityEngineService.evaluateAndPersist(updated, userId);

    return this.toDto(userId, updated, roleMap);
  }

  public async bulkAssignTasks(
    actorUserId: string,
    payload: BulkAssignTasksPayload,
  ): Promise<TaskDto[]> {
    const { taskIds, assignedTo: targetUserId } = payload;

    const targetUser = await UserModel.findById(targetUserId).lean().exec();
    if (targetUser == null) {
      throw new HttpError(404, "Target user not found");
    }

    const memberships = await getProjectMembershipsByUser(actorUserId);
    const roleMap = this.buildRoleMap(memberships);

    const tasks = await TaskModel.find({ _id: { $in: taskIds } }).exec();
    if (tasks.length === 0) {
      throw new HttpError(404, "No tasks found");
    }

    const now = new Date();
    const results: TaskDto[] = [];

    for (const task of tasks) {
      const currentRole = task.projectId
        ? (roleMap.get(task.projectId.toString()) ?? null)
        : null;
      const permission = this.getTaskPermission(
        actorUserId,
        task as any,
        currentRole,
      );

      if (permission.canAssign === false && permission.canReassign === false) {
        continue;
      }

      if (task.projectId) {
        const isMember = await ProjectMemberModel.exists(
          andRefMatches(
            buildRefMatch("projectId", task.projectId.toString()),
            buildRefMatch("userId", targetUserId),
          ),
        );
        if (!isMember) {
          continue;
        }
      }

      task.assignedTo = targetUserId as any;
      task.assignedBy = actorUserId as any;
      task.assignedAt = now;

      const updated = await task.save();
      const populated = await updated.populate(taskPopulateOptions);
      results.push(
        this.toDto(actorUserId, populated as TaskDocumentWithAssignee, roleMap),
      );
    }

    if (results.length > 0) {
      chatSocketServer.notifyUser(targetUserId, "task:bulk_assigned", {
        count: results.length,
        assignedBy: actorUserId,
      });
    }

    return results;
  }

  public async deleteTask(taskId: string, userId: string): Promise<void> {
    const memberships = await getProjectMembershipsByUser(userId);
    const roleMap = this.buildRoleMap(memberships);
    const task = await getTaskByIdAndUser(
      taskId,
      userId,
      Array.from(roleMap.keys()),
    );

    if (task == null) {
      throw new HttpError(404, "Task not found");
    }

    const currentRole = task.projectId
      ? (roleMap.get(task.projectId.toString()) ?? null)
      : null;
    const permission = this.getTaskPermission(userId, task, currentRole);

    if (permission.canDelete === false) {
      throw new HttpError(403, "Task deletion not allowed");
    }

    const deleted = await deleteTask(taskId);

    if (deleted === false) {
      throw new HttpError(404, "Task not found");
    }
  }

  public async getSummary(
    userId: string,
    date?: unknown,
  ): Promise<TaskSummary> {
    const tasks = await this.fetchTasks(userId, date);
    const total = tasks.length;
    const backlog = tasks.filter((task) => task.status === "BACKLOG").length;
    const todo = tasks.filter((task) => task.status === "TODO").length;
    const inProgress = tasks.filter(
      (task) => task.status === "IN_PROGRESS",
    ).length;
    const inReview = tasks.filter((task) => task.status === "IN_REVIEW").length;
    const blocked = tasks.filter((task) => task.status === "BLOCKED").length;
    const done = tasks.filter((task) => task.status === "DONE").length;
    const rolledOver = tasks.filter(
      (task) => task.status === "rolled_over",
    ).length;

    return {
      total,
      backlog,
      todo,
      inProgress,
      inReview,
      blocked,
      done,
      rolledOver,
      date: this.normalizeDate(date as any),
    };
  }

  private toDto(
    currentUserId: string,
    task: TaskDocumentWithAssignee,
    roleMap: Map<string, ProjectRole>,
  ): TaskDto {
    const projectId = task.projectId?.toString() ?? null;
    const currentRole = projectId ? (roleMap.get(projectId) ?? null) : null;
    const permissions = this.getTaskPermission(
      currentUserId,
      task,
      currentRole,
    );

    return {
      id: task._id.toString(),
      userId: task.userId.toString(),
      title: task.title,
      description: task.description,
      note: task.note,
      date: task.date,
      status: this.normalizeStoredTaskStatus(task.status),
      priority: task.priority || "MEDIUM",
      basePriority: task.basePriority || task.priority || "MEDIUM",
      dynamicPriority: task.dynamicPriority || task.priority || "MEDIUM",
      urgencyScore: task.urgencyScore ?? 0,
      impactScore: task.impactScore ?? 0,
      dependencyWeight: task.dependencyWeight ?? 0,
      dynamicPriorityScore: task.dynamicPriorityScore ?? 0,
      priorityEscalatedAt: task.priorityEscalatedAt?.toISOString() ?? null,
      priorityEscalationReason: task.priorityEscalationReason ?? "",
      isBlocked: task.isBlocked || false,
      blockedByTaskId: task.blockedByTaskId?.toString() ?? null,
      order: task.order || 0,
      rolledOver: task.rolledOver,
      rolloverCount: task.rolloverCount,
      projectId,
      epicId: task.epicId?.toString() ?? null,
      assignedTo: this.toTaskUser(task.assignedTo)!,
      assignedBy: this.toTaskUser(task.assignedBy),
      assignedAt: (task.assignedAt || new Date()).toISOString(),
      subtasks: this.toSubtaskDtos(task.subtasks),
      slaResponseDueAt: task.slaResponseDueAt?.toISOString() ?? null,
      slaResolutionDueAt: task.slaResolutionDueAt?.toISOString() ?? null,
      responseBreached: task.responseBreached ?? false,
      resolutionBreached: task.resolutionBreached ?? false,
      firstResponseAt: task.firstResponseAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      slaPausedAt: task.slaPausedAt?.toISOString() ?? null,
      totalPausedDuration: task.totalPausedDuration ?? 0,
      currentSlaState: task.currentSlaState ?? "HEALTHY",
      permissions,
    };
  }

  private toTaskUser(value: unknown): TaskUserDto | null {
    if (value == null || typeof value !== "object") {
      return null;
    }

    const user = value as IUserDocument;

    if (user._id == null || user.email == null) {
      return null;
    }

    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name ?? null,
    };
  }

  private async assertCanReassign(
    userId: string,
    task: TaskDocumentWithAssignee,
    permission: TaskPermissionsDto,
    assigneeId: string,
  ): Promise<void> {
    if (!task.projectId) {
      // Personal tasks can only be assigned to their owner.
      if (assigneeId !== userId) {
        throw new HttpError(403, "Personal tasks cannot be reassigned");
      }
      return;
    }
    if (!permission.canAssign) {
      throw new HttpError(403, "Task reassignment not allowed");
    }
    if (!mongoose.isValidObjectId(assigneeId)) {
      throw new HttpError(400, "Invalid assignee");
    }
    const isMember = await ProjectMemberModel.exists({
      projectId: task.projectId,
      userId: assigneeId,
    });
    if (!isMember) {
      throw new HttpError(400, "Assignee must be a project member");
    }
  }

  private buildRoleMap(
    memberships: Awaited<ReturnType<typeof getProjectMembershipsByUser>>,
  ): Map<string, ProjectRole> {
    return new Map(
      memberships.map((membership) => [
        membership.projectId.toString(),
        membership.role,
      ]),
    );
  }

  private getTaskPermission(
    currentUserId: string,
    task: TaskDocumentWithAssignee,
    role: ProjectRole | null,
  ): TaskPermissionsDto {
    const isCreator = task.userId.toString() === currentUserId;
    const isAdmin = role === "ADMIN";
    const isAssignee = (task.subtasks ?? []).some(
      (st) => st.assignedToUserId?.toString() === currentUserId,
    );

    return {
      canEdit: isAdmin || isCreator,
      canDelete: isAdmin,
      canAssign: task.projectId != null && (isAdmin || isCreator),
      canUpdate:
        isAdmin ||
        isCreator ||
        isAssignee ||
        refId(task.assignedTo) === currentUserId ||
        role !== null,
      canReassign: task.projectId != null && (isAdmin || isCreator),
    };
  }

  private async resolveEpicId(
    projectId: string | null,
    epicId: string | null | undefined,
    userId: string,
  ): Promise<{ projectId: string | null; epicId: string | null }> {
    if (epicId == null) {
      return { projectId, epicId: null };
    }

    if (projectId == null) {
      // Corrected: Use direct lookup to avoid project matching requirement
      const epic = await epicService.getEpicById(epicId);
      if (epic) {
        projectId = epic.projectId;
      } else {
        throw new HttpError(400, "Epic assignment requires a project");
      }
    }

    await projectService.assertProjectMembership(userId, projectId!);
    const epic = await epicService.assertEpicInProject(projectId!, epicId);
    return { projectId: projectId!, epicId: epic.id };
  }

  private async resolveUpdatedEpicId(
    userId: string,
    currentProjectId: string | null,
    currentEpicId: string | null,
    nextProjectId: string | null,
    requestedEpicId: string | null | undefined,
  ): Promise<string | null> {
    if (requestedEpicId !== undefined) {
      const resolved = await this.resolveEpicId(
        nextProjectId,
        requestedEpicId,
        userId,
      );
      return resolved.epicId;
    }

    if (currentProjectId !== nextProjectId) {
      if (currentEpicId == null || nextProjectId == null) {
        return null;
      }

      if (currentProjectId == null) {
        return null;
      }

      const currentEpic = await epicService.assertEpicInProject(
        currentProjectId,
        currentEpicId,
      );

      if (currentEpic.projectId !== nextProjectId) {
        return null;
      }
    }

    return currentEpicId;
  }

  private toSubtaskDtos(subtasks?: ISubtask[]): SubtaskDto[] {
    return (subtasks ?? []).map((subtask) => ({
      id: this.getSubtaskId(subtask),
      title: subtask.title,
      note: subtask.note,
      status: subtask.status,
      completed: subtask.completed,
      completedAt: subtask.completedAt ?? null,
      assignedToUserId: subtask.assignedToUserId?.toString() ?? null,
      assignedToUser: this.toTaskUser(subtask.assignedToUserId),
    }));
  }

  private getSubtaskId(subtask: ISubtask): string {
    const subtaskWithId = subtask as ISubtask & { _id?: unknown };
    return subtaskWithId._id != null ? String(subtaskWithId._id) : "";
  }

  private normalizeSubtasks(subtasks: unknown): ISubtask[] {
    if (subtasks === undefined) {
      return [];
    }

    if (!Array.isArray(subtasks)) {
      throw new HttpError(400, "Subtasks must be an array");
    }

    return subtasks.map((subtask, index) =>
      this.normalizeSubtask(subtask, index),
    );
  }

  private normalizeSubtask(value: unknown, index: number): ISubtask {
    if (value == null || typeof value !== "object") {
      throw new HttpError(400, `Subtask at index ${index} must be an object`);
    }

    const subtask = value as Record<string, unknown>;
    const title = typeof subtask.title === "string" ? subtask.title.trim() : "";
    const note = typeof subtask.note === "string" ? subtask.note.trim() : "";

    if (!title) {
      throw new HttpError(400, `Subtask at index ${index} requires a title`);
    }

    const status = this.normalizeWorkflowStatus(subtask.status);
    const completed = status === "DONE";
    const completedAt = completed
      ? this.normalizeCompletedAt(subtask.completedAt)
      : null;

    const subtaskId = subtask.id || subtask._id;

    return {
      _id: subtaskId ? this.normalizeNullableId(subtaskId) : undefined,
      title,
      note,
      status,
      completed,
      completedAt,
      assignedToUserId: this.normalizeNullableId(subtask.assignedToUserId),
    };
  }

  private normalizeTaskStatus(status: TaskStatus): TaskStatus {
    if (status === "rolled_over") {
      return status;
    }

    return this.normalizeWorkflowStatus(status);
  }

  private normalizeStoredTaskStatus(status: string): TaskStatus {
    const s = status.toUpperCase();
    if (s === "DONE" || s === "COMPLETED") return "DONE";
    if (s === "PENDING") return "TODO";
    return s as TaskStatus;
  }

  private applyCompletedStatusToSubtasks(
    taskStatus: TaskStatus | undefined,
    subtasks: ISubtask[],
  ): ISubtask[] {
    if (taskStatus !== "DONE") {
      return subtasks;
    }

    return subtasks.map((subtask) => ({
      ...subtask,
      status: "DONE",
      completed: true,
      completedAt: subtask.completedAt ?? new Date(),
    }));
  }

  private reconcileTaskStatusWithSubtasks(
    taskStatus: TaskStatus | undefined,
    subtasks: ISubtask[],
  ): TaskStatus | undefined {
    if (subtasks.length === 0) {
      return taskStatus;
    }

    const normalizedTaskStatus =
      taskStatus == null
        ? undefined
        : this.normalizeStoredTaskStatus(taskStatus);

    if (subtasks.every((subtask) => subtask.status === "DONE")) {
      return "DONE";
    }

    if (normalizedTaskStatus === "DONE") {
      return "DONE";
    }

    if (subtasks.some((subtask) => subtask.status === "IN_REVIEW")) {
      return "IN_REVIEW";
    }

    if (subtasks.some((subtask) => subtask.status === "IN_PROGRESS")) {
      return "IN_PROGRESS";
    }

    return "TODO";
  }

  private recordTaskUpdateEvents(
    userId: string,
    previousTask: TaskDocumentWithAssignee,
    updatedTask: TaskDocumentWithAssignee,
  ): void {
    const previousStatus = this.normalizeStoredTaskStatus(previousTask.status);
    const nextStatus = this.normalizeStoredTaskStatus(updatedTask.status);
    const common = {
      entityType: "task" as const,
      entityId: updatedTask._id.toString(),
      userId,
      projectId: updatedTask.projectId?.toString() ?? null,
    };

    operationalAnalyticsService.recordEventSafely({
      ...common,
      eventName: "task_updated",
      metadata: {
        previousStatus,
        nextStatus,
        assignedTo: updatedTask.assignedTo?.toString(),
        priority: updatedTask.priority,
      },
    });

    if (previousStatus !== "IN_PROGRESS" && nextStatus === "IN_PROGRESS") {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_started",
        metadata: { previousStatus, nextStatus },
      });
    }

    if (previousStatus !== nextStatus) {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_status_changed",
        metadata: {
          previousStatus,
          nextStatus,
          transition: {
            before: { status: previousStatus },
            after: { status: nextStatus },
          },
        },
      });

      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "workflow_stage_changed",
        entityType: "workflow",
        metadata: {
          taskId: updatedTask._id.toString(),
          previousStage: previousStatus,
          nextStage: nextStatus,
        },
      });
    }

    if (previousTask.priority !== updatedTask.priority) {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_priority_changed",
        metadata: {
          previousPriority: previousTask.priority,
          nextPriority: updatedTask.priority,
        },
      });
    }

    if (previousTask.date !== updatedTask.date) {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_due_date_changed",
        metadata: {
          previousDueDate: previousTask.date,
          nextDueDate: updatedTask.date,
        },
      });
    }

    if (previousStatus !== "DONE" && nextStatus === "DONE") {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_completed",
        metadata: { previousStatus, nextStatus },
      });
    }

    if (previousStatus === "DONE" && nextStatus !== "DONE") {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_reopened",
        metadata: { previousStatus, nextStatus },
      });
    }

    // Review lifecycle tracking — feeds review_latency and workflow_bottlenecks metrics
    if (previousStatus !== "IN_REVIEW" && nextStatus === "IN_REVIEW") {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "review_requested",
        metadata: {
          previousStatus,
          nextStatus,
          transition: {
            before: { status: previousStatus },
            after: { status: "IN_REVIEW" },
          },
        },
      });
    }

    if (previousStatus === "IN_REVIEW" && nextStatus === "DONE") {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "review_completed",
        metadata: {
          previousStatus: "IN_REVIEW",
          nextStatus: "DONE",
          transition: {
            before: { status: "IN_REVIEW" },
            after: { status: "DONE" },
          },
        },
      });
    }

    // Escalation tracking — feeds escalation_frequency metric
    if (
      previousTask.priority !== updatedTask.priority &&
      updatedTask.priority === "HIGH" &&
      previousTask.priority !== "HIGH"
    ) {
      operationalAnalyticsService.recordEventSafely({
        ...common,
        eventName: "task_escalated",
        metadata: {
          previousPriority: previousTask.priority,
          nextPriority: updatedTask.priority,
          escalationTrigger: "priority_escalation",
        },
      });
    }
  }

  private normalizeWorkflowStatus(value: unknown): TaskWorkflowStatus {
    if (typeof value !== "string") {
      return "TODO";
    }

    const s = value.toUpperCase();
    const valid: TaskWorkflowStatus[] = [
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "BLOCKED",
      "DONE",
    ];

    if (valid.includes(s as TaskWorkflowStatus)) {
      return s as TaskWorkflowStatus;
    }

    if (s === "COMPLETED") return "DONE";
    if (s === "PENDING") return "TODO";

    return "TODO";
  }

  private normalizeCompletedAt(value: unknown): Date {
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

  private normalizeOptionalText(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    return value.trim();
  }

  private normalizeNullableId(value: unknown): string | null {
    if (value == null) {
      return null;
    }

    if (typeof value !== "string") {
      return null;
    }

    const id = value.trim();
    return id === "" || id === "null" || id === "undefined" ? null : id;
  }

  private normalizeDate(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const date = value.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  }
}

const taskService = new TaskService();
export default taskService;
