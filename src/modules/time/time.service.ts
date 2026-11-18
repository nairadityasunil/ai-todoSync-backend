import { Types } from "mongoose";

import TaskModel from "../task/models/task.model.js";
import projectService from "../project/services/project.service.js";
import TimeEntryModel from "./time-entry.model.js";

class TimeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const parseDay = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !DAY.test(value))
    throw new TimeError(400, `${label} must be a date like 2026-11-16`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new TimeError(400, `${label} is not a real date`);
  return value;
};

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Monday of the week the day falls in. */
const mondayOf = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return addDays(day, -back);
};

/**
 * The last day a timesheet may reach: today, plus a day of slack so people ahead of UTC (their "today" has
 * already started here) are not refused. The portal limits itself to the person's own today.
 */
const latestAllowedDay = (): string => addDays(new Date().toISOString().slice(0, 10), 1);

const parseMinutes = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 24 * 60)
    throw new TimeError(400, "Time must be between 1 minute and 24 hours");
  return Math.round(n);
};

const oid = (value: unknown, label: string): Types.ObjectId => {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value))
    throw new TimeError(400, `${label} is not valid`);
  return new Types.ObjectId(value);
};

export interface WeekResult {
  weekStart: string;
  days: string[];
  scope: "me" | "all";
  entries: Array<{
    id: string;
    userId: string;
    userName: string;
    taskId: string | null;
    taskTitle: string | null;
    date: string;
    minutes: number;
    note: string;
  }>;
  /** Minutes per person for the week, so admins can compare. */
  totals: Array<{ userId: string; userName: string; minutes: number }>;
  /** Tasks in the project, for the "log time on" picker, with their estimates. */
  tasks: Array<{ id: string; title: string; estimatedHours: number | null }>;
}

class TimeService {
  /**
   * One week of time for the project. A member sees their own; an admin may ask for `scope: "all"`
   * (everyone) or a single `userId`.
   */
  public async getWeek(
    actorId: string,
    projectId: string,
    query: { start?: unknown; scope?: unknown; userId?: unknown },
  ): Promise<WeekResult> {
    const access = await projectService.assertProjectPermission(
      actorId,
      projectId,
      "time",
    );
    const monday = mondayOf(
      query.start
        ? parseDay(query.start, "start")
        : new Date().toISOString().slice(0, 10),
    );
    if (monday > latestAllowedDay())
      throw new TimeError(400, "Time cannot be viewed for upcoming weeks");
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const wantsAll = query.scope === "all";
    const filter: Record<string, unknown> = {
      projectId: new Types.ObjectId(projectId),
      date: { $gte: days[0], $lte: days[6] },
    };
    let scope: "me" | "all" = "me";
    if (access.role === "ADMIN" && (wantsAll || query.userId)) {
      if (query.userId) filter.userId = oid(query.userId, "userId");
      else scope = "all";
    } else {
      filter.userId = new Types.ObjectId(actorId);
    }
    if (access.role !== "ADMIN" && (wantsAll || query.userId))
      throw new TimeError(
        403,
        "Only project admins can see other people's time",
      );

    const [entries, tasks, members] = await Promise.all([
      TimeEntryModel.find(filter).sort({ date: 1, createdAt: 1 }).lean(),
      TaskModel.find({ projectId: new Types.ObjectId(projectId) })
        .select("title estimatedHours")
        .sort({ updatedAt: -1 })
        .limit(300)
        .lean(),
      projectService.fetchProjectMembers(actorId, projectId),
    ]);
    const names = new Map(
      members.map((m) => [m.userId, m.user.name || m.user.email]),
    );
    const titles = new Map(tasks.map((t) => [String(t._id), t.title]));
    const totals = new Map<string, number>();
    const rows = entries.map((e) => {
      const uid = String(e.userId);
      totals.set(uid, (totals.get(uid) ?? 0) + e.minutes);
      return {
        id: String(e._id),
        userId: uid,
        userName: names.get(uid) ?? "Former member",
        taskId: e.taskId ? String(e.taskId) : null,
        taskTitle: e.taskId
          ? (titles.get(String(e.taskId)) ?? "Deleted task")
          : null,
        date: e.date,
        minutes: e.minutes,
        note: e.note ?? "",
      };
    });
    return {
      weekStart: monday,
      days,
      scope,
      entries: rows,
      totals: [...totals].map(([userId, minutes]) => ({
        userId,
        userName: names.get(userId) ?? "Former member",
        minutes,
      })),
      tasks: tasks.map((t) => ({
        id: String(t._id),
        title: t.title,
        estimatedHours:
          typeof t.estimatedHours === "number" ? t.estimatedHours : null,
      })),
    };
  }

  /**
   * Every entry between two days (inclusive, at most a year), for exporting a timesheet. A member gets
   * their own time; a project admin may ask for everyone (`scope: "all"`) or one person (`userId`).
   */
  public async getRange(
    actorId: string,
    projectId: string,
    query: { from?: unknown; to?: unknown; scope?: unknown; userId?: unknown },
  ): Promise<{
    from: string;
    to: string;
    scope: "me" | "all";
    entries: WeekResult["entries"];
  }> {
    const access = await projectService.assertProjectPermission(
      actorId,
      projectId,
      "time",
    );
    const from = parseDay(query.from, "from");
    const to = parseDay(query.to, "to");
    if (to < from) throw new TimeError(400, "The end date is before the start");
    if (to > latestAllowedDay())
      throw new TimeError(400, "The export cannot reach into the future");
    if (addDays(from, 366) < to)
      throw new TimeError(400, "Choose a range of one year or less");
    const wantsOthers = query.scope === "all" || Boolean(query.userId);
    if (wantsOthers && access.role !== "ADMIN")
      throw new TimeError(
        403,
        "Only project admins can see other people's time",
      );
    const filter: Record<string, unknown> = {
      projectId: new Types.ObjectId(projectId),
      date: { $gte: from, $lte: to },
    };
    let scope: "me" | "all" = "me";
    if (wantsOthers) {
      if (query.userId) filter.userId = oid(query.userId, "userId");
      else scope = "all";
    } else {
      filter.userId = new Types.ObjectId(actorId);
    }
    const entries = await TimeEntryModel.find(filter)
      .sort({ date: 1, createdAt: 1 })
      .limit(20000)
      .lean();
    const taskIds = [
      ...new Set(entries.filter((e) => e.taskId).map((e) => String(e.taskId))),
    ].map((id) => new Types.ObjectId(id));
    const [tasks, members] = await Promise.all([
      taskIds.length
        ? TaskModel.find({ _id: { $in: taskIds } })
            .select("title")
            .lean()
        : Promise.resolve([]),
      projectService.fetchProjectMembers(actorId, projectId),
    ]);
    const names = new Map(
      members.map((m) => [m.userId, m.user.name || m.user.email]),
    );
    const titles = new Map(tasks.map((t) => [String(t._id), t.title]));
    return {
      from,
      to,
      scope,
      entries: entries.map((e) => ({
        id: String(e._id),
        userId: String(e.userId),
        userName: names.get(String(e.userId)) ?? "Former member",
        taskId: e.taskId ? String(e.taskId) : null,
        taskTitle: e.taskId
          ? (titles.get(String(e.taskId)) ?? "Deleted task")
          : null,
        date: e.date,
        minutes: e.minutes,
        note: e.note ?? "",
      })),
    };
  }

  public async addEntry(
    actorId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const access = await projectService.assertProjectPermission(
      actorId,
      projectId,
      "time",
    );
    const userId =
      body.userId && body.userId !== actorId ? String(body.userId) : actorId;
    if (userId !== actorId && access.role !== "ADMIN")
      throw new TimeError(
        403,
        "Only project admins can log time for someone else",
      );
    const taskId = body.taskId ? oid(body.taskId, "taskId") : null;
    if (taskId) {
      const ok = await TaskModel.exists({
        _id: taskId,
        projectId: new Types.ObjectId(projectId),
      });
      if (!ok) throw new TimeError(404, "That task is not in this project");
    }
    const entry = await TimeEntryModel.create({
      projectId: new Types.ObjectId(projectId),
      userId: oid(userId, "userId"),
      taskId,
      date: parseDay(body.date, "date"),
      minutes: parseMinutes(body.minutes),
      note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
    });
    return { id: String(entry._id) };
  }

  private async ownedEntry(
    actorId: string,
    projectId: string,
    entryId: string,
  ) {
    const access = await projectService.assertProjectPermission(
      actorId,
      projectId,
      "time",
    );
    const entry = await TimeEntryModel.findOne({
      _id: oid(entryId, "entryId"),
      projectId: new Types.ObjectId(projectId),
    });
    if (!entry) throw new TimeError(404, "Time entry not found");
    if (String(entry.userId) !== actorId && access.role !== "ADMIN")
      throw new TimeError(403, "You can only change your own time");
    return entry;
  }

  public async updateEntry(
    actorId: string,
    projectId: string,
    entryId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const entry = await this.ownedEntry(actorId, projectId, entryId);
    if (body.minutes !== undefined) entry.minutes = parseMinutes(body.minutes);
    if (body.date !== undefined) entry.date = parseDay(body.date, "date");
    if (typeof body.note === "string") entry.note = body.note.slice(0, 500);
    await entry.save();
  }

  public async deleteEntry(
    actorId: string,
    projectId: string,
    entryId: string,
  ): Promise<void> {
    const entry = await this.ownedEntry(actorId, projectId, entryId);
    await entry.deleteOne();
  }
}

export default new TimeService();
