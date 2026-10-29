import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import { HttpError } from "../../shared/errors/http-error.js";
import UserModel from "../auth/models/user.model.js";
import ProjectModel from "../project/models/project.model.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { raiseAlert } from "./activity.service.js";
import {
  budgetStatus,
  DEFAULT_MONTHLY_AI_BUDGET_USD,
  monthKey,
  monthStart,
  reachedThresholds,
} from "./budget.js";
import { AgentModel } from "./model.js";

/**
 * AI spend per workspace: monthly budgets with alerts and an optional hard
 * stop, and a breakdown of cost by provider, agent, person and project.
 *
 * Live spend is cached per process for SPEND_TTL_MS and topped up with each
 * call this process makes, so the budget check costs no query per call.
 * Other instances' calls show up within the TTL.
 */

const SPEND_TTL_MS = 15_000;
const SETTINGS_TTL_MS = 30_000;

interface BudgetSettings {
  budgetUsd: number;
  hardStop: boolean;
}

const oid = (id: string | Types.ObjectId) => new Types.ObjectId(id.toString());

class CostService {
  private spend = new Map<string, { usd: number; month: string; at: number }>();
  private settings = new Map<string, { value: BudgetSettings; at: number }>();
  private alerted = new Set<string>();

  public invalidate(workspaceId: string): void {
    this.settings.delete(workspaceId);
    this.spend.delete(workspaceId);
  }

  public async budgetSettings(workspaceId: string): Promise<BudgetSettings> {
    const hit = this.settings.get(workspaceId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
    const workspace = await WorkspaceModel.findById(workspaceId)
      .select("settings.aiMonthlyBudgetUsd settings.aiBudgetHardStop")
      .lean();
    const value = {
      budgetUsd:
        workspace?.settings?.aiMonthlyBudgetUsd ??
        DEFAULT_MONTHLY_AI_BUDGET_USD,
      hardStop: workspace?.settings?.aiBudgetHardStop ?? true,
    };
    this.settings.set(workspaceId, { value, at: Date.now() });
    return value;
  }

  /** This month's AI spend in USD (UTC month). */
  public async monthlySpend(workspaceId: string, now = new Date()) {
    const month = monthKey(now);
    const hit = this.spend.get(workspaceId);
    if (hit && hit.month === month && Date.now() - hit.at < SPEND_TTL_MS)
      return hit.usd;
    const [row] = await PromptExecutionLogModel.aggregate<{ usd: number }>([
      {
        $match: {
          workspaceId: oid(workspaceId),
          createdAt: { $gte: monthStart(now) },
          status: "success",
        },
      },
      { $group: { _id: null, usd: { $sum: "$totalCost" } } },
    ]);
    const usd = row?.usd ?? 0;
    if (this.spend.size > 10_000) this.spend.clear();
    this.spend.set(workspaceId, { usd, month, at: Date.now() });
    return usd;
  }

  /** Refuses the call when the workspace is over a hard-stop budget. */
  public async assertWithinBudget(workspaceId: string): Promise<void> {
    if (!Types.ObjectId.isValid(workspaceId)) return;
    const { budgetUsd, hardStop } = await this.budgetSettings(workspaceId);
    if (!hardStop || budgetUsd <= 0) return;
    const spent = await this.monthlySpend(workspaceId);
    if (spent >= budgetUsd) {
      throw new HttpError(
        429,
        `This workspace has used its monthly AI budget ($${budgetUsd.toFixed(2)}; $${spent.toFixed(2)} spent). A workspace admin can raise it in Agent Governance → Costs.`,
      );
    }
  }

  /** Adds a finished call to live spend and alerts admins at 80% and 100%. */
  public async recordSpend(input: {
    workspaceId: string;
    costUsd: number;
    providerAgentId?: string | null;
  }): Promise<void> {
    const { workspaceId, costUsd } = input;
    if (!Types.ObjectId.isValid(workspaceId) || !(costUsd > 0)) return;
    try {
      const spent = (await this.monthlySpend(workspaceId)) + costUsd;
      const entry = this.spend.get(workspaceId);
      if (entry) entry.usd = spent;
      const { budgetUsd, hardStop } = await this.budgetSettings(workspaceId);
      const month = monthKey();
      for (const threshold of reachedThresholds(spent, budgetUsd)) {
        const key = `ai_budget:${workspaceId}:${month}:${threshold}`;
        if (this.alerted.has(key) || !input.providerAgentId) continue;
        this.alerted.add(key);
        await raiseAlert({
          workspaceId,
          agentId: input.providerAgentId,
          type: "ai_budget",
          severity: threshold >= 100 ? "critical" : "warning",
          title:
            threshold >= 100
              ? "Monthly AI budget used up"
              : `${threshold}% of the monthly AI budget used`,
          detail: `$${spent.toFixed(2)} of $${budgetUsd.toFixed(2)} spent in ${month}.${
            threshold >= 100
              ? hardStop
                ? " AI calls are refused until next month or until the budget is raised."
                : " AI calls continue: the hard stop is off."
              : ""
          }`,
          dedupeKey: key,
        });
      }
    } catch (error) {
      logger.warn("Could not update AI spend", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Spend per UTC day; falls back to reading rows where date operators are missing. */
  private async dailyRows(match: Record<string, unknown>) {
    try {
      const day = {
        $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
      };
      const [totals, failures] = await Promise.all([
        PromptExecutionLogModel.aggregate<{
          _id: string;
          cost: number;
          calls: number;
          tokens: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: day,
              cost: { $sum: "$totalCost" },
              calls: { $sum: 1 },
              tokens: { $sum: "$totalTokens" },
            },
          },
        ]),
        PromptExecutionLogModel.aggregate<{ _id: string; n: number }>([
          { $match: { ...match, status: "error" } },
          { $group: { _id: day, n: { $sum: 1 } } },
        ]),
      ]);
      const failed = new Map(failures.map((f) => [f._id, f.n]));
      return totals
        .map((row) => ({ ...row, errors: failed.get(row._id) ?? 0 }))
        .sort((x, y) => x._id.localeCompare(y._id));
    } catch {
      const docs = await PromptExecutionLogModel.find(match)
        .select("createdAt status totalCost totalTokens")
        .limit(50_000)
        .lean();
      return this.foldDays(
        docs.map((doc) => ({
          day: new Date(doc.createdAt as Date).toISOString().slice(0, 10),
          status: doc.status,
          cost: doc.totalCost ?? 0,
          calls: 1,
          tokens: doc.totalTokens ?? 0,
        })),
      );
    }
  }

  private foldDays(
    parts: Array<{
      day: string;
      status: string;
      cost: number;
      calls: number;
      tokens: number;
    }>,
  ) {
    const days = new Map<
      string,
      {
        _id: string;
        cost: number;
        calls: number;
        tokens: number;
        errors: number;
      }
    >();
    for (const part of parts) {
      const day = days.get(part.day) ?? {
        _id: part.day,
        cost: 0,
        calls: 0,
        tokens: 0,
        errors: 0,
      };
      if (part.status === "success") day.cost += part.cost;
      else day.errors += part.calls;
      day.calls += part.calls;
      day.tokens += part.tokens;
      days.set(part.day, day);
    }
    return [...days.values()].sort((x, y) => x._id.localeCompare(y._id));
  }

  /** Cost for one month, broken down for the Costs tab. */
  public async report(workspaceId: string, range: { from: Date; to: Date }) {
    const match = {
      workspaceId: oid(workspaceId),
      createdAt: { $gte: range.from, $lt: range.to },
    };
    type Row = {
      _id: unknown;
      cost: number;
      calls: number;
      tokens: number;
      errors: number;
    };
    // Failed calls are logged with no cost, so spend sums over every row;
    // failures are counted in a second, filtered pass. (Plain group keys
    // keep this portable to MongoDB-compatible stores.)
    const group = async (key: string): Promise<Row[]> => {
      const [totals, failures] = await Promise.all([
        PromptExecutionLogModel.aggregate<Omit<Row, "errors">>([
          { $match: match },
          {
            $group: {
              _id: `$${key}`,
              cost: { $sum: "$totalCost" },
              calls: { $sum: 1 },
              tokens: { $sum: "$totalTokens" },
            },
          },
        ]),
        PromptExecutionLogModel.aggregate<{ _id: unknown; n: number }>([
          { $match: { ...match, status: "error" } },
          { $group: { _id: `$${key}`, n: { $sum: 1 } } },
        ]),
      ]);
      const failed = new Map(failures.map((f) => [String(f._id), f.n]));
      return totals
        .map((row) => ({ ...row, errors: failed.get(String(row._id)) ?? 0 }))
        .sort((x, y) => y.cost - x.cost)
        .slice(0, 50);
    };
    const [byProvider, byAgent, byUser, byProject, bySource, byDay] =
      await Promise.all([
        group("provider"),
        group("agentId"),
        group("userId"),
        group("projectId"),
        group("source"),
        this.dailyRows(match),
      ]);

    const ids = (rows: Row[]) =>
      rows
        .map((row) => row._id)
        .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
    const [agents, users, projects] = await Promise.all([
      AgentModel.find({ _id: { $in: ids(byAgent) } })
        .select("name kind")
        .lean(),
      UserModel.find({ _id: { $in: ids(byUser) } })
        .select("name email")
        .lean(),
      ProjectModel.find({ _id: { $in: ids(byProject) } })
        .select("name")
        .lean(),
    ]);
    const nameOf = <T extends { _id: Types.ObjectId }>(
      docs: T[],
      label: (doc: T) => string,
    ) => {
      const names = new Map(
        docs.map((doc) => [doc._id.toString(), label(doc)]),
      );
      return (id: unknown) => (id ? names.get(String(id)) : undefined);
    };
    const agentName = nameOf(agents, (a) => a.name);
    const agentKind = nameOf(agents, (a) => a.kind);
    const userName = nameOf(users, (u) => u.name || u.email);
    const projectName = nameOf(projects, (p) => p.name);
    const row = (
      r: Row,
      label: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id: r._id == null ? null : String(r._id),
      label,
      cost: Number(r.cost.toFixed(6)),
      calls: r.calls,
      tokens: r.tokens,
      errors: r.errors,
      ...extra,
    });

    const total = byProvider.reduce(
      (sum, r) => ({
        cost: sum.cost + r.cost,
        calls: sum.calls + r.calls,
        tokens: sum.tokens + r.tokens,
        errors: sum.errors + r.errors,
      }),
      { cost: 0, calls: 0, tokens: 0, errors: 0 },
    );
    const { budgetUsd, hardStop } = await this.budgetSettings(workspaceId);
    return {
      month: range.from.toISOString().slice(0, 7),
      budgetUsd,
      hardStop,
      ...budgetStatus(total.cost, budgetUsd),
      total: { ...total, cost: Number(total.cost.toFixed(6)) },
      byProvider: byProvider.map((r) => row(r, String(r._id ?? "unknown"))),
      byAgent: byAgent.map((r) =>
        r._id
          ? row(r, agentName(r._id) ?? "Removed agent", {
              kind: agentKind(r._id) ?? null,
            })
          : row(r, "People in the portal", { kind: null }),
      ),
      byUser: byUser.map((r) => row(r, userName(r._id) ?? "Removed user")),
      byProject: byProject.map((r) =>
        row(
          r,
          r._id ? (projectName(r._id) ?? "Removed project") : "No project",
        ),
      ),
      bySource: bySource.map((r) => row(r, String(r._id ?? "unknown"))),
      daily: byDay.map((r) => row(r, String(r._id))),
    };
  }
}

export default new CostService();
