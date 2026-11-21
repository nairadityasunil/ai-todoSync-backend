import { Types } from "mongoose";

import TaskModel from "../task/models/task.model.js";
import projectService from "../project/services/project.service.js";
import ProjectModel from "../project/models/project.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import TimeEntryModel from "./time-entry.model.js";
import activityLogService from "../audit/services/activity-log.service.js";

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
const latestAllowedDay = (): string =>
  addDays(new Date().toISOString().slice(0, 10), 1);

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

export interface MyWeekResult {
  /** Monday of the week. */
  weekStart: string;
  /** The seven days, Monday first. */
  days: string[];
  /** Only projects the person logged time on this week, the most time first. */
  projects: Array<{
    projectId: string;
    name: string;
    minutes: number;
    /** Minutes for each of the seven days. */
    byDay: number[];
  }>;
  totalMinutes: number;
  /** Minutes for each of the seven days, across projects. */
  totalByDay: number[];
  /**
   * The same time grouped by workspace: every workspace the person is part of (even with no time that week)
   * and any other workspace they logged time in, each with its projects that have time.
   */
  workspaces: Array<{
    workspaceId: string | null;
    name: string;
    minutes: number;
    projects: MyWeekResult["projects"];
  }>;
}

class TimeService {
  /**
   * The signed-in person's own time for one week across every project: minutes per project and per day.
   * Projects with no time that week are left out.
   */
  public async getMyWeek(
    userId: string,
    query: { start?: unknown },
  ): Promise<MyWeekResult> {
    const monday = mondayOf(
      query.start
        ? parseDay(query.start, "start")
        : new Date().toISOString().slice(0, 10),
    );
    if (monday > latestAllowedDay())
      throw new TimeError(400, "Time cannot be viewed for upcoming weeks");
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const entries = await TimeEntryModel.find({
      userId: new Types.ObjectId(userId),
      date: { $gte: days[0], $lte: days[6] },
    })
      .select("projectId date minutes")
      .lean();

    const byProject = new Map<string, number[]>();
    for (const e of entries) {
      const slot = days.indexOf(e.date);
      if (slot < 0) continue;
      const id = String(e.projectId);
      const row = byProject.get(id) ?? Array<number>(7).fill(0);
      row[slot] += e.minutes;
      byProject.set(id, row);
    }
    const projectDocs = await ProjectModel.find({
      _id: { $in: [...byProject.keys()].map((k) => new Types.ObjectId(k)) },
    })
      .select("name workspaceId")
      .lean();
    const info = new Map(
      projectDocs.map((p) => [
        String(p._id),
        {
          name: p.name,
          workspaceId: p.workspaceId ? String(p.workspaceId) : null,
        },
      ]),
    );
    const sum = (a: number[]): number => a.reduce((n, v) => n + v, 0);
    const projects = [...byProject]
      .map(([projectId, byDay]) => ({
        projectId,
        name: info.get(projectId)?.name ?? "Deleted project",
        minutes: sum(byDay),
        byDay,
      }))
      .filter((p) => p.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
    const totalByDay = days.map((_, i) =>
      projects.reduce((n, p) => n + p.byDay[i], 0),
    );

    // Group by workspace: all the person's workspaces, plus any other one they logged time in.
    const memberships = await WorkspaceMemberModel.find({
      userId: new Types.ObjectId(userId),
    })
      .select("workspaceId")
      .lean();
    const groupIds = new Set(memberships.map((m) => String(m.workspaceId)));
    for (const p of projects) {
      const w = info.get(p.projectId)?.workspaceId;
      if (w) groupIds.add(w);
    }
    const workspaceNames = new Map(
      (
        await WorkspaceModel.find({
          _id: { $in: [...groupIds].map((k) => new Types.ObjectId(k)) },
        })
          .select("name")
          .lean()
      ).map((w) => [String(w._id), w.name]),
    );
    const grouped = new Map<string | null, typeof projects>();
    for (const id of groupIds) grouped.set(id, []);
    for (const p of projects) {
      const w = info.get(p.projectId)?.workspaceId ?? null;
      grouped.set(w, [...(grouped.get(w) ?? []), p]);
    }
    const workspaces = [...grouped]
      .map(([workspaceId, list]) => ({
        workspaceId,
        name: workspaceId
          ? (workspaceNames.get(workspaceId) ?? "Workspace")
          : "No workspace",
        minutes: list.reduce((n, p) => n + p.minutes, 0),
        projects: list,
      }))
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
    return {
      weekStart: monday,
      days,
      projects,
      totalMinutes: sum(totalByDay),
      totalByDay,
      workspaces,
    };
  }

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
    actorName?: string,
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
    let taskTitle: string | undefined;
    if (taskId) {
      const taskDoc = await TaskModel.findOne({
        _id: taskId,
        projectId: new Types.ObjectId(projectId),
      })
        .select("title")
        .lean();
      if (!taskDoc)
        throw new TimeError(404, "That task is not in this project");
      taskTitle = taskDoc.title;
    }
    const entry = await TimeEntryModel.create({
      projectId: new Types.ObjectId(projectId),
      userId: oid(userId, "userId"),
      taskId,
      date: parseDay(body.date, "date"),
      minutes: parseMinutes(body.minutes),
      note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
    });

    void activityLogService.logActivity({
      projectId,
      entityType: "time",
      entityId: String(entry._id),
      entityName: taskTitle
        ? `Time on ${taskTitle}`
        : `Time log on ${entry.date}`,
      action: "created",
      userId: actorId,
      userName: actorName || "User",
      description: `Logged ${Math.floor(entry.minutes / 60)}h ${entry.minutes % 60}m on ${entry.date}${taskTitle ? ` for "${taskTitle}"` : ""}`,
      changes: [
        { field: "minutes", newValue: String(entry.minutes) },
        { field: "date", newValue: entry.date },
        ...(entry.note ? [{ field: "note", newValue: entry.note }] : []),
      ],
    });

    return { id: String(entry._id) };
  }

  /** Every time entry on one task (newest first) with who logged it, and the summed time. */
  public async getTaskTime(
    actorId: string,
    projectId: string,
    taskId: string,
  ): Promise<{
    totalMinutes: number;
    entries: Array<{
      id: string;
      userId: string;
      userName: string;
      date: string;
      minutes: number;
      note: string;
      canModify: boolean;
    }>;
  }> {
    const access = await projectService.assertProjectPermission(
      actorId,
      projectId,
      "time",
    );
    const tid = oid(taskId, "taskId");
    const inProject = await TaskModel.exists({
      _id: tid,
      projectId: new Types.ObjectId(projectId),
    });
    if (!inProject)
      throw new TimeError(404, "That task is not in this project");
    const [entries, members] = await Promise.all([
      TimeEntryModel.find({
        projectId: new Types.ObjectId(projectId),
        taskId: tid,
      })
        .sort({ date: -1, createdAt: -1 })
        .limit(500)
        .lean(),
      projectService.fetchProjectMembers(actorId, projectId),
    ]);
    const names = new Map(
      members.map((m) => [m.userId, m.user.name || m.user.email]),
    );
    let totalMinutes = 0;
    const rows = entries.map((e) => {
      const uid = String(e.userId);
      totalMinutes += e.minutes;
      return {
        id: String(e._id),
        userId: uid,
        userName: names.get(uid) ?? "Former member",
        date: e.date,
        minutes: e.minutes,
        note: e.note ?? "",
        canModify: uid === actorId || access.role === "ADMIN",
      };
    });
    return { totalMinutes, entries: rows };
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
    actorName?: string,
  ): Promise<void> {
    const entry = await this.ownedEntry(actorId, projectId, entryId);
    const oldMinutes = entry.minutes;
    const oldDate = entry.date;
    const oldNote = entry.note;
    const changes: Array<{
      field: string;
      oldValue?: string;
      newValue?: string;
    }> = [];

    if (body.minutes !== undefined) {
      entry.minutes = parseMinutes(body.minutes);
      if (entry.minutes !== oldMinutes) {
        changes.push({
          field: "minutes",
          oldValue: String(oldMinutes),
          newValue: String(entry.minutes),
        });
      }
    }
    if (body.date !== undefined) {
      entry.date = parseDay(body.date, "date");
      if (entry.date !== oldDate) {
        changes.push({
          field: "date",
          oldValue: oldDate,
          newValue: entry.date,
        });
      }
    }
    if (typeof body.note === "string") {
      entry.note = body.note.slice(0, 500);
      if (entry.note !== oldNote) {
        changes.push({
          field: "note",
          oldValue: oldNote,
          newValue: entry.note,
        });
      }
    }
    await entry.save();

    void activityLogService.logActivity({
      projectId,
      entityType: "time",
      entityId: String(entry._id),
      entityName: `Time log on ${entry.date}`,
      action: "updated",
      userId: actorId,
      userName: actorName || "User",
      description: `Updated time entry on ${entry.date}`,
      changes,
    });
  }

  public async deleteEntry(
    actorId: string,
    projectId: string,
    entryId: string,
    actorName?: string,
  ): Promise<void> {
    const entry = await this.ownedEntry(actorId, projectId, entryId);
    const deletedMinutes = entry.minutes;
    const deletedDate = entry.date;
    await entry.deleteOne();

    void activityLogService.logActivity({
      projectId,
      entityType: "time",
      entityId: String(entry._id),
      entityName: `Time log on ${deletedDate}`,
      action: "deleted",
      userId: actorId,
      userName: actorName || "User",
      description: `Deleted time log of ${deletedMinutes}m on ${deletedDate}`,
      changes: [
        { field: "minutes", oldValue: String(deletedMinutes) },
        { field: "date", oldValue: deletedDate },
      ],
    });
  }
}

export default new TimeService();
