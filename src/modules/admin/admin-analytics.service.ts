import UserModel from "../auth/models/user.model.js";
import DeviceSessionModel from "../auth/models/device-session.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import ProjectModel from "../project/models/project.model.js";
import TaskModel from "../task/models/task.model.js";
import InvitationModel from "../workspace/models/invitation.model.js";
import PromptLibraryModel from "../prompt/models/prompt-library.model.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import ActivityLogModel from "../audit/models/activity-log.model.js";
import { AgentModel } from "../agents/model.js";
import { isEnvSuperAdmin } from "./super-admin.js";

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Every day of the window, oldest first, so charts have no gaps. */
const dayList = (days: number): string[] => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, i) =>
    isoDay(new Date(today.getTime() - (days - 1 - i) * DAY_MS)),
  );
};

const perDay = (
  days: string[],
  rows: Array<{ _id: string } & Record<string, number>>,
  key: string,
): number[] => {
  const m = new Map(rows.map((r) => [r._id, r[key] ?? 0]));
  return days.map((d) => m.get(d) ?? 0);
};

const byDay = (field: string) => ({
  $dateToString: { format: "%Y-%m-%d", date: field },
});

type Row = { _id: string; n: number } & Record<string, number>;
type Source = {
  aggregate: (p: unknown[]) => Promise<unknown[]>;
  find: (f: unknown) => {
    select: (s: string) => { lean: () => Promise<unknown[]> };
  };
};
const field = (name: string): string => "$" + name;

/**
 * Counts (and sums) per calendar day. Uses one aggregation; if the database cannot bucket dates,
 * it reads the few fields needed and buckets in memory, so the panel works on any MongoDB-compatible store.
 */
async function daily(
  model: Source,
  match: Record<string, unknown>,
  sums: Record<string, string> = {},
): Promise<Row[]> {
  try {
    const group: Record<string, unknown> = {
      _id: byDay("$createdAt"),
      n: { $sum: 1 },
    };
    for (const [k, f] of Object.entries(sums)) group[k] = { $sum: field(f) };
    return (await model.aggregate([
      { $match: match },
      { $group: group },
    ])) as Row[];
  } catch {
    const docs = (await model
      .find(match)
      .select(["createdAt", ...Object.values(sums)].join(" "))
      .lean()) as Array<Record<string, unknown>>;
    const out = new Map<string, Row>();
    for (const d of docs) {
      const day = isoDay(new Date(d.createdAt as Date));
      const row =
        out.get(day) ??
        ({
          _id: day,
          n: 0,
          ...Object.fromEntries(Object.keys(sums).map((k) => [k, 0])),
        } as Row);
      row.n += 1;
      for (const [k, f] of Object.entries(sums)) row[k] += Number(d[f] ?? 0);
      out.set(day, row);
    }
    return [...out.values()];
  }
}

/** People active per day (each person once a day). */
async function dailyDistinct(
  model: Source,
  match: Record<string, unknown>,
  userField: string,
): Promise<Row[]> {
  try {
    return (await model.aggregate([
      { $match: match },
      { $group: { _id: { d: byDay("$createdAt"), u: field(userField) } } },
      { $group: { _id: "$_id.d", n: { $sum: 1 } } },
    ])) as Row[];
  } catch {
    const docs = (await model
      .find(match)
      .select("createdAt " + userField)
      .lean()) as Array<Record<string, unknown>>;
    const sets = new Map<string, Set<string>>();
    for (const d of docs) {
      const day = isoDay(new Date(d.createdAt as Date));
      const set = sets.get(day) ?? new Set<string>();
      set.add(String(d[userField]));
      sets.set(day, set);
    }
    return [...sets].map(([day, set]) => ({ _id: day, n: set.size }) as Row);
  }
}

const round = (n: number, p = 4): number => Math.round(n * 10 ** p) / 10 ** p;

class AdminAnalyticsService {
  public async overview(rawDays: number) {
    const span = [7, 30, 90, 365].includes(rawDays) ? rawDays : 30;
    const days = dayList(span);
    const since = new Date(`${days[0]}T00:00:00.000Z`);
    const now = Date.now();
    const d1 = new Date(now - DAY_MS);
    const d7 = new Date(now - 7 * DAY_MS);
    const d30 = new Date(now - 30 * DAY_MS);
    const listed = (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const distinctActive = async (from: Date): Promise<number> =>
      (
        await DeviceSessionModel.distinct("userId", {
          lastUsedAt: { $gte: from },
        })
      ).length;

    const [
      usersTotal,
      usersSuspended,
      usersDeleted,
      superAdmins,
      twoFactor,
      google,
      workspaces,
      projects,
      tasksTotal,
      tasksDone,
      promptsTotal,
      runsTotal,
      agentsTotal,
      invites,
      dau,
      wau,
      mau,
      signups,
      tasksCreated,
      projectsCreated,
      aiDaily,
      aiErrorsDaily,
      activeDaily,
      taskStatus,
      taskPriority,
      aiProviders,
      aiProviderErrors,
      aiSources,
      topAiWorkspaces,
      topWorkspaces,
      agentKinds,
      newUsersWindow,
    ] = await Promise.all([
      UserModel.countDocuments({}),
      UserModel.countDocuments({ accountStatus: "suspended" }),
      UserModel.countDocuments({ accountStatus: "deleted" }),
      UserModel.countDocuments({
        accountStatus: { $nin: ["suspended", "deleted"] },
        $or: [
          { platformRole: "super_admin" },
          ...(listed.length ? [{ email: { $in: listed } }] : []),
        ],
      }),
      UserModel.countDocuments({ twoFactorEnabled: true }),
      UserModel.countDocuments({ authProvider: "google" }),
      WorkspaceModel.countDocuments({}),
      ProjectModel.countDocuments({}),
      TaskModel.countDocuments({}),
      TaskModel.countDocuments({ status: "DONE" }),
      PromptLibraryModel.countDocuments({ parentId: null }).catch(() => 0),
      PromptExecutionLogModel.countDocuments({}),
      AgentModel.countDocuments({}),
      InvitationModel.aggregate([
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
      distinctActive(d1),
      distinctActive(d7),
      distinctActive(d30),
      daily(UserModel as never, { createdAt: { $gte: since } }),
      daily(TaskModel as never, { createdAt: { $gte: since } }),
      daily(ProjectModel as never, { createdAt: { $gte: since } }),
      daily(
        PromptExecutionLogModel as never,
        { createdAt: { $gte: since } },
        { tokens: "totalTokens", cost: "totalCost" },
      ),
      daily(PromptExecutionLogModel as never, {
        createdAt: { $gte: since },
        status: "error",
      }),
      dailyDistinct(
        ActivityLogModel as never,
        { createdAt: { $gte: since } },
        "userId",
      ),
      TaskModel.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      TaskModel.aggregate([{ $group: { _id: "$priority", n: { $sum: 1 } } }]),
      PromptExecutionLogModel.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { p: "$provider", m: "$modelName" },
            runs: { $sum: 1 },
            tokens: { $sum: "$totalTokens" },
            cost: { $sum: "$totalCost" },
            latency: { $sum: "$latencyMs" },
          },
        },
        { $sort: { runs: -1 } },
        { $limit: 12 },
      ]),
      PromptExecutionLogModel.aggregate([
        { $match: { createdAt: { $gte: since }, status: "error" } },
        {
          $group: {
            _id: { p: "$provider", m: "$modelName" },
            errors: { $sum: 1 },
          },
        },
      ]),
      PromptExecutionLogModel.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$source", runs: { $sum: 1 } } },
        { $sort: { runs: -1 } },
      ]),
      PromptExecutionLogModel.aggregate([
        { $match: { createdAt: { $gte: since }, workspaceId: { $ne: null } } },
        {
          $group: {
            _id: "$workspaceId",
            runs: { $sum: 1 },
            cost: { $sum: "$totalCost" },
            tokens: { $sum: "$totalTokens" },
          },
        },
        { $sort: { cost: -1, runs: -1 } },
        { $limit: 8 },
      ]),
      WorkspaceMemberModel.aggregate([
        { $group: { _id: "$workspaceId", members: { $sum: 1 } } },
        { $sort: { members: -1 } },
        { $limit: 8 },
      ]),
      AgentModel.aggregate([
        { $group: { _id: "$kind", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      UserModel.countDocuments({ createdAt: { $gte: since } }),
    ]);

    const wsIds = [
      ...topAiWorkspaces.map((r: { _id: unknown }) => r._id),
      ...topWorkspaces.map((r: { _id: unknown }) => r._id),
    ];
    const wsDocs = await WorkspaceModel.find({ _id: { $in: wsIds as never[] } })
      .select("name")
      .lean();
    const wsName = new Map(wsDocs.map((w) => [String(w._id), w.name]));

    const inv: Record<string, number> = {
      PENDING: 0,
      ACCEPTED: 0,
      REJECTED: 0,
    };
    for (const r of invites as Array<{ _id: string; n: number }>)
      inv[r._id] = r.n;
    const aiRuns = aiDaily.reduce((n: number, r: Row) => n + r.n, 0);
    const aiErrors = aiErrorsDaily.reduce((n: number, r: Row) => n + r.n, 0);
    const provErr = new Map(
      aiProviderErrors.map(
        (r: { _id: { p: string; m: string }; errors: number }) => [
          `${r._id.p}|${r._id.m}`,
          r.errors,
        ],
      ),
    );
    const aiCost = aiDaily.reduce((n: number, r: Row) => n + (r.cost ?? 0), 0);
    const aiTokens = aiDaily.reduce(
      (n: number, r: Row) => n + (r.tokens ?? 0),
      0,
    );

    return {
      days: span,
      from: days[0],
      to: days[days.length - 1],
      totals: {
        users: usersTotal,
        activeUsers: usersTotal - usersSuspended - usersDeleted,
        suspendedUsers: usersSuspended,
        deletedUsers: usersDeleted,
        superAdmins,
        newUsers: newUsersWindow,
        workspaces,
        projects,
        tasks: tasksTotal,
        tasksDone,
        prompts: promptsTotal,
        aiRunsAllTime: runsTotal,
        agents: agentsTotal,
      },
      engagement: { dau, wau, mau, stickiness: mau ? round(dau / mau, 3) : 0 },
      security: {
        twoFactorEnabled: twoFactor,
        twoFactorShare: usersTotal ? round(twoFactor / usersTotal, 3) : 0,
        googleSignIn: google,
        passwordSignIn: usersTotal - google,
      },
      invitations: {
        ...inv,
        acceptanceRate:
          inv.ACCEPTED + inv.REJECTED
            ? round(inv.ACCEPTED / (inv.ACCEPTED + inv.REJECTED), 3)
            : null,
      },
      ai: {
        runs: aiRuns,
        errors: aiErrors,
        errorRate: aiRuns ? round(aiErrors / aiRuns, 3) : 0,
        tokens: aiTokens,
        cost: round(aiCost),
        providers: aiProviders.map(
          (r: {
            _id: { p: string; m: string };
            runs: number;
            tokens: number;
            cost: number;
            latency: number;
          }) => ({
            provider: r._id.p,
            model: r._id.m,
            runs: r.runs,
            errors: provErr.get(`${r._id.p}|${r._id.m}`) ?? 0,
            tokens: r.tokens,
            cost: round(r.cost),
            avgLatencyMs: r.runs ? Math.round((r.latency ?? 0) / r.runs) : 0,
          }),
        ),
        sources: aiSources.map((r: { _id: string; runs: number }) => ({
          source: r._id ?? "unknown",
          runs: r.runs,
        })),
        topWorkspaces: topAiWorkspaces.map(
          (r: {
            _id: unknown;
            runs: number;
            cost: number;
            tokens: number;
          }) => ({
            id: String(r._id),
            name: wsName.get(String(r._id)) ?? "Unknown",
            runs: r.runs,
            cost: round(r.cost),
            tokens: r.tokens,
          }),
        ),
      },
      tasks: {
        done: tasksDone,
        completionRate: tasksTotal ? round(tasksDone / tasksTotal, 3) : 0,
        byStatus: taskStatus.map((r: { _id: string; n: number }) => ({
          status: r._id ?? "UNKNOWN",
          count: r.n,
        })),
        byPriority: taskPriority.map((r: { _id: string; n: number }) => ({
          priority: r._id ?? "UNKNOWN",
          count: r.n,
        })),
      },
      agentKinds: agentKinds.map((r: { _id: string; n: number }) => ({
        kind: r._id ?? "unknown",
        count: r.n,
      })),
      topWorkspaces: topWorkspaces.map(
        (r: { _id: unknown; members: number }) => ({
          id: String(r._id),
          name: wsName.get(String(r._id)) ?? "Unknown",
          members: r.members,
        }),
      ),
      series: {
        days,
        signups: perDay(days, signups, "n"),
        activeUsers: perDay(days, activeDaily, "n"),
        tasksCreated: perDay(days, tasksCreated, "n"),
        projectsCreated: perDay(days, projectsCreated, "n"),
        aiRuns: perDay(days, aiDaily, "n"),
        aiErrors: perDay(days, aiErrorsDaily, "n"),
        aiCost: perDay(days, aiDaily, "cost").map((c) => round(c)),
        aiTokens: perDay(days, aiDaily, "tokens"),
      },
    };
  }
}

export { isEnvSuperAdmin };
export default new AdminAnalyticsService();
