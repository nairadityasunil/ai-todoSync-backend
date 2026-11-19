import { richTextToPlain, sanitizeRichText } from "../../../utils/rich-text.js";
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
import { emailAssignee } from "./task-assignment-mail.service.js";
import TaskModel from "../models/task.model.js";
import ProjectModel from "../../project/models/project.model.js";
import { ensureDefaultWorkflow } from "../../project/default-workflow.js";
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
  "stateId",
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

interface TaskNoteDto {
  id: string;
  /** Always set: the note's own title, or the start of its text for notes written without one. */
  title: string;
  text: string;
  authorId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface TaskDto {
  id: string;
  userId: string;
  title: string;
  description?: string;
  note?: string;
  /** Every note on the task, oldest first. A single older `note` shows as one note. */
  notes: TaskNoteDto[];
  /** The project workflow state the task is in, if the project has states. */
  stateId: string | null;
  date: string | null;
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
  /** False when the task's project has SLA tracking turned off: show no SLA information for it. */
  slaTracked: boolean;
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

export const MAX_TASK_TITLE_LENGTH = 300;

/** A workflow state's category decides which built-in status a task gets, so SLA and analytics keep working. */
const STATE_CATEGORY_STATUS: Record<string, string> = {
  BACKLOG: "BACKLOG",
  UNSTARTED: "TODO",
  STARTED: "IN_PROGRESS",
  COMPLETED: "DONE",
  CANCELED: "DONE",
};
const STATUS_STATE_CATEGORY: Record<string, string> = {
  BACKLOG: "BACKLOG",
  TODO: "UNSTARTED",
  IN_PROGRESS: "STARTED",
  IN_REVIEW: "STARTED",
  BLOCKED: "STARTED",
  DONE: "COMPLETED",
};

interface WorkflowStateLite {
  _id?: unknown;
  category: string;
  position?: number;
}

class TaskService {
  private async projectStates(
    projectId: string | null,
  ): Promise<WorkflowStateLite[]> {
    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) return [];
    let project = await ProjectModel.findById(projectId)
      .select("states statesInitialized")
      .lean();
    if (project && !project.statesInitialized) {
      await ensureDefaultWorkflow(projectId);
      project = await ProjectModel.findById(projectId)
        .select("states statesInitialized")
        .lean();
    }
    return ((project?.states ?? []) as WorkflowStateLite[])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  /**
   * Keeps a task's workflow state and its built-in status in step. Picking a state sets the status from the
   * state's category; changing the status picks the project's first state of the matching category.
   */
  private async applyWorkflowState(
    projectId: string | null,
    fields: { status?: string; stateId?: unknown; projectChanged?: boolean },
  ): Promise<{ status?: string; stateId?: string | null }> {
    const out: { status?: string; stateId?: string | null } = {};
    if (!projectId) {
      if (fields.stateId !== undefined || fields.projectChanged)
        out.stateId = null;
      return out;
    }
    const states = await this.projectStates(projectId);
    if (
      fields.stateId !== undefined &&
      fields.stateId !== null &&
      fields.stateId !== ""
    ) {
      const state = states.find(
        (s) => String(s._id) === String(fields.stateId),
      );
      if (!state)
        throw new HttpError(400, "That workflow state is not in this project");
      out.stateId = String(state._id);
      out.status = STATE_CATEGORY_STATUS[state.category] ?? "TODO";
      return out;
    }
    if (fields.stateId === null || fields.stateId === "") {
      out.stateId = null;
      return out;
    }
    if (
      (fields.status !== undefined || fields.projectChanged) &&
      states.length
    ) {
      const category =
        STATUS_STATE_CATEGORY[fields.status ?? "TODO"] ?? "UNSTARTED";
      // No state of that kind? Use the nearest column: open work goes to the first one, finished work to the last.
      const match =
        states.find((s) => s.category === category) ??
        (category === "COMPLETED"
          ? (states.find((s) => s.category === "CANCELED") ??
            states[states.length - 1])
          : states[0]);
      out.stateId = match ? String(match._id) : null;
    } else if (fields.projectChanged) {
      out.stateId = null;
    }
    return out;
  }

  public async createTask(payload: CreateTaskPayload): Promise<TaskDto> {
    if (payload.title == null || payload.title === "") {
      throw new HttpError(400, "Title is required");
    }
    // The due date is optional: none given means the task has no due date.
    payload.date = this.parseDueDate(payload.date);
    if (String(payload.title).trim().length > MAX_TASK_TITLE_LENGTH) {
      throw new HttpError(
        400,
        `Task title can be at most ${MAX_TASK_TITLE_LENGTH} characters (this one has ${String(payload.title).trim().length}).`,
      );
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

    payload.note = this.normalizeNote(payload.note);

    if (payload.status != null) {
      payload.status = this.normalizeTaskStatus(payload.status);
    }

    {
      const wf = await this.applyWorkflowState(payload.projectId ?? null, {
        status: payload.status ?? "TODO",
        stateId: (payload as { stateId?: unknown }).stateId,
      });
      if (wf.status !== undefined)
        payload.status = wf.status as typeof payload.status;
      (payload as { stateId?: string | null }).stateId = wf.stateId ?? null;
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
      payload.projectId ? String(payload.projectId) : null,
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

    // Someone else was given the task: tell them by email.
    if (payload.assignedTo && String(payload.assignedTo) !== payload.userId)
      void emailAssignee({
        taskIds: [task._id.toString()],
        assigneeId: String(payload.assignedTo),
        assignerId: payload.userId,
      });

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
    /** Only the tasks of this workspace's projects (plus the person's own tasks that belong to no project). */
    workspaceId?: string,
  ): Promise<TaskDto[]> {
    const normalizedDate = this.normalizeDate(date);
    const memberships = await getProjectMembershipsByUser(userId);
    let projectIds = memberships.map((membership) =>
      membership.projectId.toString(),
    );
    const roleMap = this.buildRoleMap(memberships);
    if (workspaceId) {
      const inWorkspace = new Set(
        (
          await ProjectModel.find({ workspaceId })
            .select({ _id: 1 })
            .lean()
            .exec()
        ).map((p) => String(p._id)),
      );
      projectIds = projectIds.filter((id) => inWorkspace.has(id));
    }
    const personalOnly = Boolean(workspaceId);
    const tasks = normalizedDate
      ? await getTasksByDate(
          userId,
          projectIds,
          normalizedDate,
          assigneeId,
          search,
          personalOnly,
        )
      : await getTasksByUser(
          userId,
          projectIds,
          assigneeId,
          search,
          personalOnly,
        );
    return this.withoutDuplicatedRolloverOriginals(tasks).map((task) =>
      this.toDto(userId, task, roleMap),
    );
  }

  /**
   * An old nightly rollover marked a task "rolled_over" and copied it to the next day. Where that copy exists the
   * original is a duplicate and is left out; where it does not (the copy was never made) the original is the only
   * copy of the task, so it stays in the list. A task is never hidden just for carrying that mark.
   */
  private withoutDuplicatedRolloverOriginals<
    T extends {
      status: string;
      userId?: unknown;
      projectId?: unknown;
      title: string;
      rolloverCount?: number;
    },
  >(tasks: T[]): T[] {
    if (!tasks.some((task) => task.status === "rolled_over")) return tasks;
    const key = (task: T, count: number): string =>
      `${String(task.userId)}|${String(task.projectId ?? "")}|${task.title}|${count}`;
    const live = new Set(
      tasks
        .filter((task) => task.status !== "rolled_over")
        .map((task) => key(task, task.rolloverCount ?? 0)),
    );
    return tasks.filter(
      (task) =>
        task.status !== "rolled_over" ||
        !live.has(key(task, (task.rolloverCount ?? 0) + 1)),
    );
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

    if (Object.prototype.hasOwnProperty.call(updates, "date")) {
      updates.date = this.parseDueDate(updates.date);
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
    if (nextProjectId !== (currentTask.projectId?.toString() ?? null)) {
      // Moved to another project (or out of one): it follows that project's SLA setting.
      (updates as { slaTracked?: boolean }).slaTracked =
        await slaService.isProjectSlaEnabled(nextProjectId);
    }
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
      updates.note = this.normalizeNote(updates.note);
      // Older callers set one `note`. With several notes, that edits the newest one (empty removes it).
      const stored = (currentTask.notes ?? []).map((n) => ({
        _id: n._id,
        text: n.text,
        authorId: n.authorId,
      }));
      if (stored.length > 0) {
        if (updates.note) stored[stored.length - 1].text = updates.note;
        else stored.pop();
        (updates as Record<string, unknown>).notes = stored;
        updates.note = stored.length ? stored[stored.length - 1].text : "";
      }
    }

    {
      const has = (k: string) =>
        Object.prototype.hasOwnProperty.call(updates, k);
      const nextProject = has("projectId")
        ? ((updates.projectId as string | null) ?? null)
        : (currentTask.projectId?.toString() ?? null);
      const projectChanged =
        has("projectId") &&
        nextProject !== (currentTask.projectId?.toString() ?? null);
      if (has("stateId") || has("status") || projectChanged) {
        const wf = await this.applyWorkflowState(nextProject, {
          status: has("status")
            ? (updates.status as string)
            : projectChanged
              ? this.normalizeStoredTaskStatus(currentTask.status)
              : undefined,
          stateId: has("stateId")
            ? (updates as { stateId?: unknown }).stateId
            : undefined,
          projectChanged,
        });
        if (wf.status !== undefined)
          updates.status = wf.status as typeof updates.status;
        if (wf.stateId !== undefined)
          (updates as { stateId?: string | null }).stateId = wf.stateId;
      }
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
    updates = slaService.applyStatusTransition(
      currentTask,
      updates,
      new Date(),
      currentTask.slaTracked !== false,
    );

    const updated = await updateTask(taskId, updates);

    if (updated == null) {
      throw new HttpError(404, "Task not found");
    }

    this.recordTaskUpdateEvents(userId, currentTask, updated);
    await priorityEngineService.evaluateAndPersist(updated, userId);

    if (
      updates.assignedTo !== undefined &&
      String(updates.assignedTo) !== refId(currentTask.assignedTo)
    )
      void emailAssignee({
        taskIds: [taskId],
        assigneeId: String(updates.assignedTo),
        assignerId: userId,
      });

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
      void emailAssignee({
        taskIds: [updated._id.toString()],
        assigneeId: targetUserId,
        assignerId: actorUserId,
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
      // One email for the whole batch.
      void emailAssignee({
        taskIds: results.map((r) => r.id),
        assigneeId: targetUserId,
        assignerId: actorUserId,
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
      notes: this.toNoteDtos(task),
      stateId: task.stateId ? String(task.stateId) : null,
      date: task.date ?? null,
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
      source: task.source ?? "manual",
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
      slaTracked: task.slaTracked !== false,
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

  /** The task's notes; a legacy single `note` with no stored notes shows as one note with the id "legacy". */
  private toNoteDtos(task: TaskDocumentWithAssignee): TaskNoteDto[] {
    const stored = (task.notes ?? []).map((n) => ({
      id: String(n._id),
      title: n.title?.trim() || this.titleFromText(n.text),
      text: n.text,
      authorId: n.authorId ? String(n.authorId) : null,
      createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null,
      updatedAt: n.updatedAt ? new Date(n.updatedAt).toISOString() : null,
    }));
    if (stored.length === 0 && task.note?.trim()) {
      return [
        {
          id: "legacy",
          title: this.titleFromText(task.note),
          text: task.note.trim(),
          authorId: null,
          createdAt: null,
          updatedAt: null,
        },
      ];
    }
    return stored;
  }

  private async loadTaskForNotes(taskId: string, userId: string) {
    const memberships = await getProjectMembershipsByUser(userId);
    const roleMap = this.buildRoleMap(memberships);
    const task = await getTaskByIdAndUser(
      taskId,
      userId,
      Array.from(roleMap.keys()),
    );
    if (task == null) throw new HttpError(404, "Task not found");
    const role = task.projectId
      ? (roleMap.get(task.projectId.toString()) ?? null)
      : null;
    const permission = this.getTaskPermission(userId, task, role);
    if (permission.canUpdate === false)
      throw new HttpError(403, "Task update not allowed");
    return { task, permission, roleMap };
  }

  /** Moves an older single `note` into the notes list the first time notes are changed. */
  private migrateLegacyNote(task: TaskDocumentWithAssignee): void {
    if ((task.notes ?? []).length === 0 && task.note?.trim()) {
      task.notes = [{ text: task.note.trim(), authorId: task.userId }] as never;
    }
  }

  /** The start of a note's text, used as its title when it was written without one. */
  private titleFromText(text: string): string {
    const plain = richTextToPlain(text);
    if (!plain) return "Note";
    return plain.length > 80 ? `${plain.slice(0, 77)}…` : plain;
  }

  /** The title a person gave a note: trimmed, at most 200 characters, undefined when none was sent. */
  private noteTitle(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string")
      throw new HttpError(400, "A note title must be text");
    const title = value.replace(/\s+/g, " ").trim();
    if (title.length > 200)
      throw new HttpError(400, "A note title can be at most 200 characters");
    return title;
  }

  private noteText(value: unknown): string {
    const text =
      typeof value === "string" ? sanitizeRichText(value.trim()) : "";
    if (!text || !richTextToPlain(text))
      throw new HttpError(400, "A note cannot be empty");
    // Formatting adds markup, so the limit is on the stored text; the writing itself is far shorter.
    if (text.length > 20000) throw new HttpError(400, "A note is too long");
    return text;
  }

  private async saveNotes(
    task: TaskDocumentWithAssignee,
    userId: string,
    roleMap: Map<string, ProjectRole>,
  ): Promise<TaskDto> {
    const notes = task.notes ?? [];
    task.note = notes.length ? notes[notes.length - 1].text : "";
    await task.save();
    return this.toDto(userId, task, roleMap);
  }

  public async addTaskNote(
    taskId: string,
    userId: string,
    text: unknown,
    title?: unknown,
  ): Promise<TaskDto> {
    const { task, roleMap } = await this.loadTaskForNotes(taskId, userId);
    const clean = this.noteText(text);
    const cleanTitle = this.noteTitle(title) ?? "";
    this.migrateLegacyNote(task);
    task.notes = [
      ...(task.notes ?? []),
      { title: cleanTitle, text: clean, authorId: userId },
    ] as never;
    return this.saveNotes(task, userId, roleMap);
  }

  public async updateTaskNote(
    taskId: string,
    noteId: string,
    userId: string,
    text: unknown,
    title?: unknown,
  ): Promise<TaskDto> {
    const { task, permission, roleMap } = await this.loadTaskForNotes(
      taskId,
      userId,
    );
    const clean = this.noteText(text);
    const cleanTitle = this.noteTitle(title);
    this.migrateLegacyNote(task);
    const note = (task.notes ?? []).find(
      (n) =>
        String(n._id) === noteId ||
        (noteId === "legacy" && (task.notes ?? []).length === 1),
    );
    if (!note) throw new HttpError(404, "Note not found");
    if (!permission.canEdit && String(note.authorId ?? "") !== userId)
      throw new HttpError(403, "You can only edit your own notes");
    note.text = clean;
    if (cleanTitle !== undefined) note.title = cleanTitle;
    return this.saveNotes(task, userId, roleMap);
  }

  public async deleteTaskNote(
    taskId: string,
    noteId: string,
    userId: string,
  ): Promise<TaskDto> {
    const { task, permission, roleMap } = await this.loadTaskForNotes(
      taskId,
      userId,
    );
    this.migrateLegacyNote(task);
    const list = task.notes ?? [];
    const note = list.find(
      (n) =>
        String(n._id) === noteId || (noteId === "legacy" && list.length === 1),
    );
    if (!note) throw new HttpError(404, "Note not found");
    if (!permission.canEdit && String(note.authorId ?? "") !== userId)
      throw new HttpError(403, "You can only delete your own notes");
    task.notes = list.filter((n) => n !== note) as never;
    return this.saveNotes(task, userId, roleMap);
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
    const note =
      typeof subtask.note === "string"
        ? sanitizeRichText(subtask.note.trim())
        : "";

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
    // A task an old rollover marked and never copied: show it as an ordinary open task.
    if (s === "ROLLED_OVER") return "TODO";
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

  /** A task or subtask note: trimmed, and cleaned if it holds HTML (see utils/rich-text). */
  private normalizeNote(value: unknown): string | undefined {
    const text = this.normalizeOptionalText(value);
    return text === undefined ? undefined : sanitizeRichText(text);
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

  /** A due date as YYYY-MM-DD, or null for "no due date" (missing, null or empty). Anything else is a 400. */
  private parseDueDate(value: unknown): string | null {
    if (value == null || (typeof value === "string" && value.trim() === ""))
      return null;
    const date = this.normalizeDate(value);
    if (!date)
      throw new HttpError(400, "The due date must look like 2026-11-30");
    return date;
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
