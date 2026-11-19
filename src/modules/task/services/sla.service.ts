import type { UpdateQuery } from "mongoose";

import SlaConfigModel from "../models/sla-config.model.js";
import ProjectSlaConfigModel from "../models/project-sla-config.model.js";
import ProjectModel from "../../project/models/project.model.js";
import TaskModel, {
  type ITaskDocument,
  type TaskPriority,
  type TaskSlaState,
  type TaskStatus,
} from "../../../modules/task/models/task.model.js";
import {
  getProjectMembership,
  getProjectMembershipsByUser,
} from "../../project/repositories/project-member.repository.js";
import type { UpdateTaskPayload } from "../repositories/task.repository.js";
import {
  buildRefInMatch,
  buildRefMatch,
  buildSafeRefMatch,
} from "../../../utils/mongo-ref.js";
import {
  DEFAULT_SLA_CONFIG,
  SLA_PRIORITIES,
  addHours,
  addMilliseconds,
  deriveSlaState,
} from "../../../utils/sla.js";

interface SlaConfigDto {
  id: string;
  priority: TaskPriority;
  responseTimeHours: number;
  resolutionTimeHours: number;
}

interface ProjectSlaConfigDto extends SlaConfigDto {
  /** True when the project sets its own times for this priority; false when it uses the person's defaults. */
  custom: boolean;
}

interface SlaStatusDto {
  taskId: string;
  priority: TaskPriority;
  responseDueAt: string | null;
  resolutionDueAt: string | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
  firstResponseAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  totalPausedDurationMs: number;
  currentSlaState: TaskSlaState;
  responseRemainingMs: number | null;
  resolutionRemainingMs: number | null;
}

interface SlaAnalyticsDto {
  totalBreached: number;
  breachedByPriority: Record<TaskPriority, number>;
  averageResolutionTimeHours: number;
  responseCompliancePercent: number;
  resolutionCompliancePercent: number;
}

type InitialSlaFields = Pick<
  UpdateTaskPayload,
  | "slaResponseDueAt"
  | "slaResolutionDueAt"
  | "responseBreached"
  | "resolutionBreached"
  | "firstResponseAt"
  | "completedAt"
  | "slaPausedAt"
  | "totalPausedDuration"
  | "currentSlaState"
>;

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class SlaService {
  public async getConfigs(userId: string): Promise<SlaConfigDto[]> {
    await this.ensureDefaultConfigs(userId);
    const configs = await SlaConfigModel.find({
      ...buildRefMatch("userId", userId),
    })
      .sort({ priority: 1 })
      .exec();

    return SLA_PRIORITIES.map((priority) => {
      const config = configs.find((entry) => entry.priority === priority);
      const fallback = DEFAULT_SLA_CONFIG[priority];

      return {
        id: config?._id.toString() ?? priority,
        priority,
        responseTimeHours:
          config?.responseTimeHours ?? fallback.responseTimeHours,
        resolutionTimeHours:
          config?.resolutionTimeHours ?? fallback.resolutionTimeHours,
      };
    });
  }

  public async updateConfig(
    userId: string,
    payload: {
      priority?: unknown;
      responseTimeHours?: unknown;
      resolutionTimeHours?: unknown;
    },
  ): Promise<SlaConfigDto> {
    const priority = this.normalizePriority(payload.priority);
    const responseTimeHours = this.normalizeHours(
      payload.responseTimeHours,
      "responseTimeHours",
    );
    const resolutionTimeHours = this.normalizeHours(
      payload.resolutionTimeHours,
      "resolutionTimeHours",
    );

    if (responseTimeHours >= resolutionTimeHours) {
      throw new HttpError(
        400,
        "Response SLA must be shorter than resolution SLA",
      );
    }

    const config = await SlaConfigModel.findOneAndUpdate(
      { ...buildSafeRefMatch("userId", userId), priority },
      { userId, priority, responseTimeHours, resolutionTimeHours },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    if (!config) {
      throw new HttpError(500, "Unable to update SLA config");
    }

    await this.recalculateOpenTasksForPriority(userId, priority);

    return {
      id: config._id.toString(),
      priority,
      responseTimeHours,
      resolutionTimeHours,
    };
  }

  /** Every priority's times for a project, marking which ones the project sets itself. Any member can read them. */
  public async getProjectConfigs(
    userId: string,
    projectId: string,
  ): Promise<ProjectSlaConfigDto[]> {
    await this.assertProjectMember(userId, projectId);
    const [own, personal] = await Promise.all([
      ProjectSlaConfigModel.find({
        ...buildSafeRefMatch("projectId", projectId),
      })
        .lean()
        .exec(),
      this.getConfigs(userId),
    ]);
    return personal.map((fallback) => {
      const mine = own.find((c) => c.priority === fallback.priority);
      return {
        id: mine?._id.toString() ?? fallback.id,
        priority: fallback.priority,
        responseTimeHours:
          mine?.responseTimeHours ?? fallback.responseTimeHours,
        resolutionTimeHours:
          mine?.resolutionTimeHours ?? fallback.resolutionTimeHours,
        custom: Boolean(mine),
      };
    });
  }

  /** Sets a project's own times for one priority. Only project admins can. Open tasks of that priority are re-dated. */
  public async updateProjectConfig(
    userId: string,
    projectId: string,
    payload: {
      priority?: unknown;
      responseTimeHours?: unknown;
      resolutionTimeHours?: unknown;
    },
  ): Promise<ProjectSlaConfigDto> {
    await this.assertProjectAdmin(userId, projectId);
    const priority = this.normalizePriority(payload.priority);
    const responseTimeHours = this.normalizeHours(
      payload.responseTimeHours,
      "responseTimeHours",
    );
    const resolutionTimeHours = this.normalizeHours(
      payload.resolutionTimeHours,
      "resolutionTimeHours",
    );
    if (responseTimeHours >= resolutionTimeHours) {
      throw new HttpError(
        400,
        "Response SLA must be shorter than resolution SLA",
      );
    }

    const config = await ProjectSlaConfigModel.findOneAndUpdate(
      { ...buildSafeRefMatch("projectId", projectId), priority },
      {
        projectId,
        priority,
        responseTimeHours,
        resolutionTimeHours,
        updatedBy: userId,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
    if (!config) {
      throw new HttpError(500, "Unable to update the project SLA");
    }

    await this.recalculateOpenTasksForProject(projectId, priority);
    return {
      id: config._id.toString(),
      priority,
      responseTimeHours,
      resolutionTimeHours,
      custom: true,
    };
  }

  /** Removes a project's own times for a priority, so it goes back to the person's defaults. */
  public async resetProjectConfig(
    userId: string,
    projectId: string,
    priorityInput: unknown,
  ): Promise<void> {
    await this.assertProjectAdmin(userId, projectId);
    const priority = this.normalizePriority(priorityInput);
    await ProjectSlaConfigModel.deleteOne({
      ...buildSafeRefMatch("projectId", projectId),
      priority,
    }).exec();
    await this.recalculateOpenTasksForProject(projectId, priority);
  }

  public async buildInitialSlaFields(
    userId: string,
    priority: TaskPriority | undefined,
    status: TaskStatus | undefined,
    now = new Date(),
    projectId?: string | null,
  ): Promise<InitialSlaFields> {
    const normalizedPriority = priority ?? "MEDIUM";
    const config = await this.getConfigForPriority(
      userId,
      normalizedPriority,
      projectId,
    );
    const firstResponseAt =
      status && status !== "TODO" && status !== "BACKLOG" ? now : null;
    const completedAt = status === "DONE" ? now : null;
    const isPaused = status === "BLOCKED";

    return {
      slaResponseDueAt: addHours(now, config.responseTimeHours),
      slaResolutionDueAt: addHours(now, config.resolutionTimeHours),
      responseBreached: false,
      resolutionBreached: false,
      firstResponseAt,
      completedAt,
      slaPausedAt: isPaused ? now : null,
      totalPausedDuration: 0,
      currentSlaState: completedAt
        ? "COMPLETED"
        : isPaused
          ? "PAUSED"
          : "HEALTHY",
    };
  }

  public applyStatusTransition(
    currentTask: ITaskDocument,
    updates: UpdateTaskPayload,
    now = new Date(),
  ): UpdateTaskPayload {
    const nextStatus = (updates.status ?? currentTask.status) as TaskStatus;
    const previousStatus = currentTask.status;
    const patch: UpdateTaskPayload = { ...updates };
    const createdAt = currentTask.createdAt ?? now;

    if (
      currentTask.firstResponseAt == null &&
      previousStatus === "TODO" &&
      nextStatus !== "TODO"
    ) {
      patch.firstResponseAt = now;
    }

    if (nextStatus === "DONE" && currentTask.completedAt == null) {
      patch.completedAt = now;
    }

    if (
      previousStatus === "BLOCKED" &&
      nextStatus !== "BLOCKED" &&
      currentTask.slaPausedAt
    ) {
      const pausedMs = Math.max(
        0,
        now.getTime() - currentTask.slaPausedAt.getTime(),
      );
      patch.totalPausedDuration =
        (currentTask.totalPausedDuration ?? 0) + pausedMs;
      patch.slaPausedAt = null;
      patch.slaResponseDueAt = addMilliseconds(
        currentTask.slaResponseDueAt,
        pausedMs,
      );
      patch.slaResolutionDueAt = addMilliseconds(
        currentTask.slaResolutionDueAt,
        pausedMs,
      );
      patch.isBlocked = false;
    }

    if (nextStatus === "BLOCKED" && previousStatus !== "BLOCKED") {
      patch.slaPausedAt = currentTask.slaPausedAt ?? now;
      patch.isBlocked = true;
    }

    if (previousStatus === "DONE" && nextStatus !== "DONE") {
      patch.completedAt = currentTask.completedAt ?? now;
    }

    const responseDueAt =
      patch.slaResponseDueAt ?? currentTask.slaResponseDueAt;
    const resolutionDueAt =
      patch.slaResolutionDueAt ?? currentTask.slaResolutionDueAt;
    const firstResponseAt =
      patch.firstResponseAt ?? currentTask.firstResponseAt;
    const completedAt = patch.completedAt ?? currentTask.completedAt;
    const responseBreached =
      firstResponseAt == null &&
      responseDueAt != null &&
      nextStatus !== "BLOCKED" &&
      now > responseDueAt;
    const resolutionBreached =
      completedAt == null &&
      resolutionDueAt != null &&
      nextStatus !== "BLOCKED" &&
      nextStatus !== "DONE" &&
      now > resolutionDueAt;

    patch.responseBreached = currentTask.responseBreached || responseBreached;
    patch.resolutionBreached =
      currentTask.resolutionBreached || resolutionBreached;
    patch.currentSlaState = deriveSlaState({
      status: nextStatus,
      isPaused: nextStatus === "BLOCKED",
      responseBreached: patch.responseBreached,
      resolutionBreached: patch.resolutionBreached,
      createdAt,
      responseDueAt,
      resolutionDueAt,
      now,
    });

    return patch;
  }

  public async applyPriorityChange(
    userId: string,
    currentTask: ITaskDocument,
    updates: UpdateTaskPayload,
  ): Promise<UpdateTaskPayload> {
    if (!updates.priority || updates.priority === currentTask.priority) {
      return updates;
    }

    const config = await this.getConfigForPriority(
      userId,
      updates.priority,
      currentTask.projectId ? String(currentTask.projectId) : null,
    );
    const start = currentTask.createdAt ?? new Date();
    const paused = currentTask.totalPausedDuration ?? 0;

    return {
      ...updates,
      slaResponseDueAt: addMilliseconds(
        addHours(start, config.responseTimeHours),
        paused,
      ),
      slaResolutionDueAt: addMilliseconds(
        addHours(start, config.resolutionTimeHours),
        paused,
      ),
    };
  }

  public async getTaskStatus(
    taskId: string,
    userId: string,
  ): Promise<SlaStatusDto> {
    const task = await this.getAccessibleTask(taskId, userId);
    if (!task) {
      throw new HttpError(404, "Task not found");
    }

    return this.toStatusDto(task);
  }

  public async listBreachedTasks(userId: string): Promise<ITaskDocument[]> {
    const projectIds = await this.getAccessibleProjectIds(userId);

    return TaskModel.find({
      $or: [
        buildRefMatch("userId", userId),
        buildRefInMatch("projectId", projectIds),
      ],
      $and: [
        { $or: [{ responseBreached: true }, { resolutionBreached: true }] },
      ],
    })
      .sort({ priority: 1, slaResolutionDueAt: 1 })
      .exec();
  }

  /**
   * SLA numbers for the tasks of one project, of one workspace (the projects of it the person belongs to), or,
   * with no scope, of everything the person can see. A screen about one project must pass its scope: the numbers
   * are computed from the tasks themselves, so a wider scope shows other projects' tasks as this one's.
   */
  public async getAnalytics(
    userId: string,
    scope: { projectId?: string; workspaceId?: string } = {},
  ): Promise<SlaAnalyticsDto> {
    const projectIds = await this.getAccessibleProjectIds(userId);
    let filter: Record<string, unknown>;
    if (scope.projectId) {
      if (!projectIds.includes(scope.projectId)) {
        throw new HttpError(403, "You do not have access to this project");
      }
      filter = buildRefMatch("projectId", scope.projectId);
    } else if (scope.workspaceId) {
      const inWorkspace = await ProjectModel.find(
        buildSafeRefMatch("workspaceId", scope.workspaceId),
      )
        .select({ _id: 1 })
        .lean()
        .exec();
      const mine = new Set(projectIds);
      filter = buildRefInMatch(
        "projectId",
        inWorkspace.map((p) => String(p._id)).filter((id) => mine.has(id)),
      );
    } else {
      filter = {
        $or: [
          buildRefMatch("userId", userId),
          buildRefInMatch("projectId", projectIds),
        ],
      };
    }
    // Only the fields the numbers need, as plain objects: this used to load every task in full
    // (subtasks, notes and all), which grows with the workspace.
    const tasks = await TaskModel.find(filter)
      .select(
        "priority responseBreached resolutionBreached firstResponseAt completedAt createdAt totalPausedDuration",
      )
      .lean()
      .exec();

    const breachedByPriority = SLA_PRIORITIES.reduce(
      (acc, priority) => ({ ...acc, [priority]: 0 }),
      {} as Record<TaskPriority, number>,
    );
    let totalBreached = 0;
    let responseCompliant = 0;
    let responseEligible = 0;
    let resolutionCompliant = 0;
    let resolutionEligible = 0;
    let resolutionTotalMs = 0;
    let resolutionCount = 0;

    tasks.forEach((task) => {
      const breached = task.responseBreached || task.resolutionBreached;
      if (breached) {
        totalBreached += 1;
        breachedByPriority[task.priority ?? "MEDIUM"] += 1;
      }

      if (task.firstResponseAt || task.responseBreached) {
        responseEligible += 1;
        if (!task.responseBreached) {
          responseCompliant += 1;
        }
      }

      if (task.completedAt || task.resolutionBreached) {
        resolutionEligible += 1;
        if (!task.resolutionBreached) {
          resolutionCompliant += 1;
        }
      }

      if (task.completedAt && task.createdAt) {
        resolutionTotalMs +=
          task.completedAt.getTime() -
          task.createdAt.getTime() -
          (task.totalPausedDuration ?? 0);
        resolutionCount += 1;
      }
    });

    return {
      totalBreached,
      breachedByPriority,
      averageResolutionTimeHours:
        resolutionCount === 0
          ? 0
          : Number((resolutionTotalMs / resolutionCount / 3600000).toFixed(2)),
      responseCompliancePercent:
        responseEligible === 0
          ? 100
          : Number(((responseCompliant / responseEligible) * 100).toFixed(1)),
      resolutionCompliancePercent:
        resolutionEligible === 0
          ? 100
          : Number(
              ((resolutionCompliant / resolutionEligible) * 100).toFixed(1),
            ),
    };
  }

  public async updateBreaches(now = new Date()): Promise<number> {
    const candidates = await TaskModel.find({
      status: { $nin: ["DONE", "rolled_over", "BLOCKED"] },
      $or: [
        {
          responseBreached: false,
          firstResponseAt: null,
          slaResponseDueAt: { $lt: now },
        },
        {
          resolutionBreached: false,
          completedAt: null,
          slaResolutionDueAt: { $lt: now },
        },
      ],
    }).exec();

    for (const task of candidates) {
      const responseBreached =
        task.responseBreached ||
        (task.firstResponseAt == null &&
          task.slaResponseDueAt != null &&
          now > task.slaResponseDueAt);
      const resolutionBreached =
        task.resolutionBreached ||
        (task.completedAt == null &&
          task.slaResolutionDueAt != null &&
          now > task.slaResolutionDueAt);

      task.responseBreached = responseBreached;
      task.resolutionBreached = resolutionBreached;
      task.currentSlaState = deriveSlaState({
        status: task.status,
        isPaused: false,
        responseBreached,
        resolutionBreached,
        createdAt: task.createdAt ?? now,
        responseDueAt: task.slaResponseDueAt,
        resolutionDueAt: task.slaResolutionDueAt,
        now,
      });
      await task.save();
    }

    return candidates.length;
  }

  private async ensureDefaultConfigs(userId: string): Promise<void> {
    await Promise.all(
      SLA_PRIORITIES.map((priority) =>
        SlaConfigModel.updateOne(
          { ...buildSafeRefMatch("userId", userId), priority },
          {
            $setOnInsert: {
              userId,
              priority,
              ...DEFAULT_SLA_CONFIG[priority],
            },
          },
          { upsert: true },
        ).exec(),
      ),
    );
  }

  /** The times that apply: the project's own for this priority if it sets them, else the person's, else the defaults. */
  private async getConfigForPriority(
    userId: string,
    priority: TaskPriority,
    projectId?: string | null,
  ): Promise<{ responseTimeHours: number; resolutionTimeHours: number }> {
    if (projectId) {
      const own = await ProjectSlaConfigModel.findOne({
        ...buildSafeRefMatch("projectId", projectId),
        priority,
      })
        .lean()
        .exec();
      if (own) {
        return {
          responseTimeHours: own.responseTimeHours,
          resolutionTimeHours: own.resolutionTimeHours,
        };
      }
    }
    await this.ensureDefaultConfigs(userId);
    const config = await SlaConfigModel.findOne({
      ...buildRefMatch("userId", userId),
      priority,
    }).exec();

    return config ?? DEFAULT_SLA_CONFIG[priority];
  }

  private async recalculateOpenTasksForPriority(
    userId: string,
    priority: TaskPriority,
  ): Promise<void> {
    const config = await this.getConfigForPriority(userId, priority);
    const allTasks = await TaskModel.find({
      ...buildRefMatch("userId", userId),
      priority,
      status: { $nin: ["DONE", "rolled_over"] },
    }).exec();

    // Tasks in a project that sets its own times for this priority keep the project's times.
    const projectIds = [
      ...new Set(
        allTasks.filter((t) => t.projectId).map((t) => String(t.projectId)),
      ),
    ];
    const overridden = new Set(
      projectIds.length === 0
        ? []
        : (
            await ProjectSlaConfigModel.find({
              ...buildRefInMatch("projectId", projectIds),
              priority,
            })
              .select({ projectId: 1 })
              .lean()
              .exec()
          ).map((c) => String(c.projectId)),
    );
    const tasks = allTasks.filter(
      (t) => !t.projectId || !overridden.has(String(t.projectId)),
    );

    const now = new Date();
    for (const task of tasks) {
      const start = task.createdAt ?? now;
      const paused = task.totalPausedDuration ?? 0;
      const responseDueAt = addMilliseconds(
        addHours(start, config.responseTimeHours),
        paused,
      );
      const resolutionDueAt = addMilliseconds(
        addHours(start, config.resolutionTimeHours),
        paused,
      );
      const update: UpdateQuery<ITaskDocument> = {
        slaResponseDueAt: responseDueAt,
        slaResolutionDueAt: resolutionDueAt,
      };
      await TaskModel.updateOne({ _id: task._id }, update).exec();
    }
  }

  private async assertProjectMember(
    userId: string,
    projectId: string,
  ): Promise<{ role: string }> {
    const membership = await getProjectMembership(projectId, userId);
    if (!membership) {
      throw new HttpError(403, "You do not have access to this project");
    }
    return membership;
  }

  private async assertProjectAdmin(
    userId: string,
    projectId: string,
  ): Promise<void> {
    const membership = await this.assertProjectMember(userId, projectId);
    if (membership.role !== "ADMIN") {
      throw new HttpError(403, "Only project admins can change the SLA");
    }
  }

  /** Re-dates the open tasks of a project for one priority after its times changed (or were reset). */
  private async recalculateOpenTasksForProject(
    projectId: string,
    priority: TaskPriority,
  ): Promise<void> {
    const tasks = await TaskModel.find({
      ...buildRefMatch("projectId", projectId),
      priority,
      status: { $nin: ["DONE", "rolled_over"] },
    }).exec();
    const now = new Date();
    for (const task of tasks) {
      const config = await this.getConfigForPriority(
        String(task.userId),
        priority,
        projectId,
      );
      const start = task.createdAt ?? now;
      const paused = task.totalPausedDuration ?? 0;
      await TaskModel.updateOne(
        { _id: task._id },
        {
          slaResponseDueAt: addMilliseconds(
            addHours(start, config.responseTimeHours),
            paused,
          ),
          slaResolutionDueAt: addMilliseconds(
            addHours(start, config.resolutionTimeHours),
            paused,
          ),
        },
      ).exec();
    }
  }

  private async getAccessibleTask(
    taskId: string,
    userId: string,
  ): Promise<ITaskDocument | null> {
    const projectIds = await this.getAccessibleProjectIds(userId);
    return TaskModel.findOne({
      _id: taskId,
      $or: [
        buildRefMatch("userId", userId),
        buildRefInMatch("projectId", projectIds),
      ],
    }).exec();
  }

  private async getAccessibleProjectIds(userId: string): Promise<string[]> {
    const memberships = await getProjectMembershipsByUser(userId);
    return memberships.map((membership) => membership.projectId.toString());
  }

  private normalizePriority(value: unknown): TaskPriority {
    if (
      typeof value !== "string" ||
      !SLA_PRIORITIES.includes(value as TaskPriority)
    ) {
      throw new HttpError(400, "Invalid SLA priority");
    }

    return value as TaskPriority;
  }

  private normalizeHours(value: unknown, field: string): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new HttpError(400, `${field} must be a positive number`);
    }

    return numeric;
  }

  private toStatusDto(task: ITaskDocument): SlaStatusDto {
    const now = new Date();
    const responseRemainingMs = task.slaResponseDueAt
      ? Math.max(0, task.slaResponseDueAt.getTime() - now.getTime())
      : null;
    const resolutionRemainingMs = task.slaResolutionDueAt
      ? Math.max(0, task.slaResolutionDueAt.getTime() - now.getTime())
      : null;

    return {
      taskId: task._id.toString(),
      priority: task.priority,
      responseDueAt: task.slaResponseDueAt?.toISOString() ?? null,
      resolutionDueAt: task.slaResolutionDueAt?.toISOString() ?? null,
      responseBreached: task.responseBreached,
      resolutionBreached: task.resolutionBreached,
      firstResponseAt: task.firstResponseAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      pausedAt: task.slaPausedAt?.toISOString() ?? null,
      totalPausedDurationMs: task.totalPausedDuration ?? 0,
      currentSlaState: task.currentSlaState,
      responseRemainingMs,
      resolutionRemainingMs,
    };
  }
}

export default new SlaService();
