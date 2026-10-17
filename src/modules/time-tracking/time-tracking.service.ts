import mongoose from "mongoose";
import TimeEntryModel from "./time-entry.model.js";
import TaskModel from "../task/models/task.model.js";
import ProjectMemberModel from "../project/models/project-member.model.js";
import UserModel from "../auth/models/user.model.js";
import projectService from "../project/services/project.service.js";
import accessService from "../access/access.service.js";
import { AppError } from "../../utils/app-error.js";
import { buildProjectUuidMap } from "../../utils/project-id.js";

const { ObjectId } = mongoose.Types;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HOURS_PER_DAY = 24;
const MAX_NOTE = 1000;

export interface TimeEntryInput {
  taskId?: unknown;
  hours?: unknown;
  date?: unknown;
  note?: unknown;
  /** Admins may log on behalf of a project member. */
  userId?: unknown;
}

export interface TimeFilters {
  from?: string;
  to?: string;
  userId?: string;
  taskId?: string;
}

const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
const bad = (message: string) =>
  new AppError(400, message, "INVALID_TIME_ENTRY");

/** "YYYY-MM-DD" → UTC midnight. */
const parseDay = (value: unknown, field: string): Date => {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw bad(`${field} must be a date like 2026-10-10`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw bad(`${field} is not a real date`);
  }
  return date;
};

const parseHours = (value: unknown): number => {
  const hours = typeof value === "string" ? Number(value) : value;
  if (
    typeof hours !== "number" ||
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > MAX_HOURS_PER_DAY
  ) {
    throw bad(`hours must be more than 0 and at most ${MAX_HOURS_PER_DAY}`);
  }
  return Math.round(hours * 100) / 100;
};

const parseNote = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw bad("note must be text");
  if (value.trim().length > MAX_NOTE)
    throw bad(`note must be at most ${MAX_NOTE} characters`);
  return value.trim();
};

const round = (n: number) => Math.round(n * 100) / 100;

class TimeTrackingService {
  /** Logs hours on a task in the project. Members log their own time. */
  public async createEntry(
    userId: string,
    projectId: string,
    input: TimeEntryInput,
  ) {
    const { workspaceAccess, project } = await projectService.getProjectAccess(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const ownerId = await this.resolveOwner(
      userId,
      resolvedProjectId,
      workspaceAccess.isAdmin,
      input.userId,
    );
    const taskId = await this.assertTaskInProject(
      input.taskId,
      resolvedProjectId,
    );
    const entryDate = this.assertNotFuture(parseDay(input.date, "date"));
    const hours = parseHours(input.hours);
    await this.assertDailyLimit(ownerId, entryDate, hours);

    const entry = await TimeEntryModel.create({
      workspaceId: workspaceAccess.workspaceId,
      projectId: resolvedProjectId,
      taskId,
      userId: ownerId,
      hours,
      entryDate,
      note: parseNote(input.note),
    });
    return this.toDtos([entry.toObject()]).then(([dto]) => dto);
  }

  public async listEntries(
    userId: string,
    projectId: string,
    filters: TimeFilters,
    page = 1,
    limit = 50,
  ) {
    const { project } = await projectService.getProjectAccess(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const match = this.matchFor(resolvedProjectId, filters);
    const safeLimit = Math.min(200, Math.max(1, limit));
    const [entries, total] = await Promise.all([
      TimeEntryModel.find(match)
        .sort({ entryDate: -1, createdAt: -1 })
        .skip((Math.max(1, page) - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      TimeEntryModel.countDocuments(match),
    ]);
    return {
      entries: await this.toDtos(entries),
      total,
      page: Math.max(1, page),
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  /**
   * Project totals: overall, per task, per member, per member per task, and
   * daily/weekly rollups, all computed in one aggregation.
   */
  public async summary(
    userId: string,
    projectId: string,
    filters: TimeFilters,
  ) {
    const { project } = await projectService.getProjectAccess(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const match = this.matchFor(resolvedProjectId, filters);
    const [facets] = await TimeEntryModel.aggregate<{
      total: Array<{ hours: number; entries: number }>;
      byTask: Array<{ _id: unknown; hours: number; entries: number }>;
      byMember: Array<{ _id: unknown; hours: number; entries: number }>;
      byMemberTask: Array<{
        _id: { userId: unknown; taskId: unknown };
        hours: number;
      }>;
      daily: Array<{ _id: string; hours: number }>;
      weekly: Array<{ _id: string; hours: number }>;
    }>([
      { $match: match },
      {
        $facet: {
          total: [
            {
              $group: {
                _id: null,
                hours: { $sum: "$hours" },
                entries: { $sum: 1 },
              },
            },
          ],
          byTask: [
            {
              $group: {
                _id: "$taskId",
                hours: { $sum: "$hours" },
                entries: { $sum: 1 },
              },
            },
            { $sort: { hours: -1 } },
          ],
          byMember: [
            {
              $group: {
                _id: "$userId",
                hours: { $sum: "$hours" },
                entries: { $sum: 1 },
              },
            },
            { $sort: { hours: -1 } },
          ],
          byMemberTask: [
            {
              $group: {
                _id: { userId: "$userId", taskId: "$taskId" },
                hours: { $sum: "$hours" },
              },
            },
            { $sort: { hours: -1 } },
          ],
          daily: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$entryDate",
                    timezone: "UTC",
                  },
                },
                hours: { $sum: "$hours" },
              },
            },
            { $sort: { _id: 1 } },
          ],
          weekly: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%G-W%V",
                    date: "$entryDate",
                    timezone: "UTC",
                  },
                },
                hours: { $sum: "$hours" },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);

    const taskIds = facets.byTask.map((t) => String(t._id));
    const userIds = facets.byMember.map((m) => String(m._id));
    const [tasks, users] = await Promise.all([
      this.taskTitles(taskIds),
      this.userNames(userIds),
    ]);
    const total = facets.total[0];

    return {
      projectId,
      filters,
      totalHours: round(total?.hours ?? 0),
      entryCount: total?.entries ?? 0,
      byTask: facets.byTask.map((t) => ({
        taskId: String(t._id),
        title: tasks.get(String(t._id)) ?? "Deleted task",
        hours: round(t.hours),
        entries: t.entries,
      })),
      byMember: facets.byMember.map((m) => ({
        userId: String(m._id),
        ...this.userInfo(users, String(m._id)),
        hours: round(m.hours),
        entries: m.entries,
      })),
      byMemberTask: facets.byMemberTask.map((r) => ({
        userId: String(r._id.userId),
        taskId: String(r._id.taskId),
        name: this.userInfo(users, String(r._id.userId)).name,
        taskTitle: tasks.get(String(r._id.taskId)) ?? "Deleted task",
        hours: round(r.hours),
      })),
      daily: facets.daily.map((d) => ({ date: d._id, hours: round(d.hours) })),
      weekly: facets.weekly.map((w) => ({
        week: w._id,
        hours: round(w.hours),
      })),
    };
  }

  /** One member's hours in the project, per task and per day. */
  public async memberSummary(
    userId: string,
    projectId: string,
    memberUserId: string,
    filters: TimeFilters,
  ) {
    if (!isId(memberUserId))
      throw new AppError(404, "Member not found", "NOT_FOUND");
    const summary = await this.summary(userId, projectId, {
      ...filters,
      userId: memberUserId,
    });
    const member = summary.byMember[0];
    return {
      projectId,
      userId: memberUserId,
      name: member?.name ?? null,
      email: member?.email ?? null,
      totalHours: summary.totalHours,
      entryCount: summary.entryCount,
      byTask: summary.byTask,
      daily: summary.daily,
      weekly: summary.weekly,
    };
  }

  /** Authors edit their own entries; workspace admins can edit any. */
  public async updateEntry(
    userId: string,
    entryId: string,
    input: TimeEntryInput,
  ) {
    const entry = await this.editableEntry(userId, entryId);
    const updates: Record<string, unknown> = {};
    if (input.taskId !== undefined) {
      updates.taskId = await this.assertTaskInProject(
        input.taskId,
        String(entry.projectId),
      );
    }
    if (input.date !== undefined)
      updates.entryDate = this.assertNotFuture(parseDay(input.date, "date"));
    if (input.hours !== undefined) updates.hours = parseHours(input.hours);
    if (input.note !== undefined) updates.note = parseNote(input.note);
    if (updates.hours !== undefined || updates.entryDate !== undefined) {
      await this.assertDailyLimit(
        String(entry.userId),
        (updates.entryDate as Date) ?? entry.entryDate,
        (updates.hours as number) ?? entry.hours,
        String(entry._id),
      );
    }
    const updated = await TimeEntryModel.findByIdAndUpdate(
      entry._id,
      { $set: updates },
      { new: true },
    ).lean();
    return this.toDtos([updated!]).then(([dto]) => dto);
  }

  public async deleteEntry(userId: string, entryId: string) {
    const entry = await this.editableEntry(userId, entryId);
    await TimeEntryModel.deleteOne({ _id: entry._id });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ helpers

  private matchFor(
    projectId: string,
    filters: TimeFilters,
  ): Record<string, unknown> {
    const match: Record<string, unknown> = {
      projectId: ObjectId.isValid(projectId)
        ? new ObjectId(projectId)
        : projectId,
    };
    if (filters.userId) {
      if (!isId(filters.userId)) throw bad("userId must be a member id");
      match.userId = new ObjectId(filters.userId);
    }
    if (filters.taskId) {
      if (!isId(filters.taskId)) throw bad("taskId must be a task id");
      match.taskId = new ObjectId(filters.taskId);
    }
    if (filters.from || filters.to) {
      const range: Record<string, Date> = {};
      if (filters.from) range.$gte = parseDay(filters.from, "from");
      if (filters.to) range.$lte = parseDay(filters.to, "to");
      if (range.$gte && range.$lte && range.$gte > range.$lte)
        throw bad("from must be before to");
      match.entryDate = range;
    }
    return match;
  }

  private async resolveOwner(
    userId: string,
    projectId: string,
    isAdmin: boolean,
    requested: unknown,
  ): Promise<string> {
    if (requested === undefined || requested === null || requested === userId)
      return userId;
    if (!isAdmin) {
      throw new AppError(
        403,
        "Only admins can log time for someone else.",
        "PERMISSION_DENIED",
      );
    }
    if (!isId(requested)) throw bad("userId must be a member id");
    const inProject = await ProjectMemberModel.exists({
      projectId,
      userId: requested,
    });
    if (!inProject) throw bad("That person is not a member of this project.");
    return requested;
  }

  private async assertTaskInProject(
    taskId: unknown,
    projectId: string,
  ): Promise<string> {
    if (!isId(taskId)) throw bad("Choose a task");
    const task = await TaskModel.exists({ _id: taskId, projectId });
    if (!task) throw bad("That task is not part of this project.");
    return taskId;
  }

  private assertNotFuture(date: Date): Date {
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000; // allow time zones ahead of UTC
    if (date.getTime() > tomorrow)
      throw bad("You cannot log time in the future.");
    return date;
  }

  /** Nobody logs more than 24 hours on one day across all projects. */
  private async assertDailyLimit(
    userId: string,
    entryDate: Date,
    hours: number,
    excludeEntryId?: string,
  ): Promise<void> {
    const [row] = await TimeEntryModel.aggregate<{ hours: number }>([
      {
        $match: {
          userId: new ObjectId(userId),
          entryDate,
          ...(excludeEntryId
            ? { _id: { $ne: new ObjectId(excludeEntryId) } }
            : {}),
        },
      },
      { $group: { _id: null, hours: { $sum: "$hours" } } },
    ]);
    if ((row?.hours ?? 0) + hours > MAX_HOURS_PER_DAY) {
      throw bad(
        `That would be more than ${MAX_HOURS_PER_DAY} hours on ${entryDate.toISOString().slice(0, 10)}.`,
      );
    }
  }

  private async editableEntry(userId: string, entryId: string) {
    const entry = isId(entryId)
      ? await TimeEntryModel.findById(entryId).lean()
      : null;
    if (!entry) throw new AppError(404, "Time entry not found", "NOT_FOUND");
    // Not a member of the entry's workspace/project → the entry "does not exist".
    const { access } = await accessService.resolveForProject(
      userId,
      String(entry.projectId),
    );
    if (String(entry.userId) !== userId && !access.isAdmin) {
      throw new AppError(
        403,
        "You can only change your own time entries.",
        "PERMISSION_DENIED",
      );
    }
    return entry;
  }

  private async toDtos(entries: Array<Record<string, any>>) {
    const [tasks, users, uuidMap] = await Promise.all([
      this.taskTitles(entries.map((e) => String(e.taskId))),
      this.userNames(entries.map((e) => String(e.userId))),
      buildProjectUuidMap(entries.map((e) => String(e.projectId))),
    ]);
    return entries.map((e) => ({
      id: String(e._id),
      projectId: uuidMap.get(String(e.projectId)) || String(e.projectId),
      taskId: String(e.taskId),
      taskTitle: tasks.get(String(e.taskId)) ?? "Deleted task",
      userId: String(e.userId),
      ...this.userInfo(users, String(e.userId)),
      hours: e.hours,
      date: (e.entryDate as Date).toISOString().slice(0, 10),
      note: e.note ?? "",
      createdAt: e.createdAt,
    }));
  }

  private async taskTitles(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)].filter(isId);
    if (!unique.length) return new Map();
    const rows = await TaskModel.find({ _id: { $in: unique } })
      .select({ title: 1 })
      .lean();
    return new Map(rows.map((t) => [String(t._id), t.title]));
  }

  private async userNames(
    ids: string[],
  ): Promise<Map<string, { name: string | null; email: string }>> {
    const unique = [...new Set(ids)].filter(isId);
    if (!unique.length) return new Map();
    const rows = await UserModel.find({ _id: { $in: unique } })
      .select({ name: 1, email: 1 })
      .lean();
    return new Map(
      rows.map((u) => [
        String(u._id),
        { name: u.name ?? null, email: u.email },
      ]),
    );
  }

  private userInfo(
    users: Map<string, { name: string | null; email: string }>,
    id: string,
  ) {
    const user = users.get(id);
    return {
      name: user?.name || user?.email || "Former member",
      email: user?.email ?? "",
    };
  }
}

export default new TimeTrackingService();
