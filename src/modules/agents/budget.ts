/**
 * AI budget arithmetic, kept pure for unit tests. Budgets are per workspace
 * per calendar month in UTC; cost.service applies them to live spend.
 */

export const DEFAULT_MONTHLY_AI_BUDGET_USD = 100;
export const MAX_MONTHLY_AI_BUDGET_USD = 1_000_000;
/** Spend, as a share of the budget, at which admins are alerted. */
export const BUDGET_ALERT_THRESHOLDS = [80, 100] as const;

export type BudgetLevel = "ok" | "warning" | "exceeded" | "unlimited";

/** First instant of the UTC month containing `now`. */
export const monthStart = (now = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** "2026-10" for October 2026 (UTC). */
export const monthKey = (now = new Date()): string =>
  monthStart(now).toISOString().slice(0, 7);

/** Parses "YYYY-MM" into the month's start and end (UTC); null if invalid. */
export function parseMonth(value: unknown): { from: Date; to: Date } | null {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    return null;
  const [year, month] = value.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 1)),
  };
}

/** A budget of 0 means no limit. */
export function budgetStatus(
  spentUsd: number,
  budgetUsd: number,
): { percent: number | null; level: BudgetLevel } {
  if (!budgetUsd || budgetUsd <= 0)
    return { percent: null, level: "unlimited" };
  const percent = (spentUsd / budgetUsd) * 100;
  return {
    percent,
    level: percent >= 100 ? "exceeded" : percent >= 80 ? "warning" : "ok",
  };
}

/** Alert thresholds that spend has reached; each is alerted once a month. */
export function reachedThresholds(
  spentUsd: number,
  budgetUsd: number,
): number[] {
  const { percent } = budgetStatus(spentUsd, budgetUsd);
  if (percent === null) return [];
  return BUDGET_ALERT_THRESHOLDS.filter((threshold) => percent >= threshold);
}

/** Budget from a settings value: a number from 0 (no limit) to the maximum. */
export function normalizeBudget(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONTHLY_AI_BUDGET_USD)
    return null;
  return Math.round(n * 100) / 100;
}
