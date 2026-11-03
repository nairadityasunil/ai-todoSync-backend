/** Daily event counts and sudden jumps ("spikes"), computed from event timestamps. */

export interface TrendPoint {
  date: string;
  count: number;
}

export interface EventSpike {
  eventName: string;
  /** Events in the last 24 hours. */
  last24h: number;
  /** Average per day over the 7 days before that. */
  dailyAverage: number;
  /** last24h ÷ dailyAverage (Infinity shown as the count when there was no history). */
  ratio: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

export function buildEventTrend(
  logs: Array<{ createdAt: Date | string; eventName: string }>,
  options: { days: number; now?: Date },
): { days: TrendPoint[]; spikes: EventSpike[] } {
  const now = options.now ?? new Date();
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const days: TrendPoint[] = [];
  const index = new Map<string, number>();
  for (let i = options.days - 1; i >= 0; i -= 1) {
    const key = dayKey(new Date(startOfToday.getTime() - i * DAY_MS));
    index.set(key, days.length);
    days.push({ date: key, count: 0 });
  }

  const recentCut = now.getTime() - DAY_MS;
  const baselineCut = recentCut - 7 * DAY_MS;
  const recent = new Map<string, number>();
  const baseline = new Map<string, number>();

  for (const log of logs) {
    const at = new Date(log.createdAt);
    const slot = index.get(dayKey(at));
    if (slot !== undefined) days[slot].count += 1;
    const t = at.getTime();
    if (t > recentCut) {
      recent.set(log.eventName, (recent.get(log.eventName) ?? 0) + 1);
    } else if (t > baselineCut) {
      baseline.set(log.eventName, (baseline.get(log.eventName) ?? 0) + 1);
    }
  }

  const spikes: EventSpike[] = [];
  for (const [eventName, last24h] of recent) {
    const dailyAverage = (baseline.get(eventName) ?? 0) / 7;
    // At least 10 events and double the usual daily volume (or new and busy).
    const ratio = dailyAverage > 0 ? last24h / dailyAverage : last24h;
    if (last24h >= 10 && ratio >= 2) {
      spikes.push({
        eventName,
        last24h,
        dailyAverage: Math.round(dailyAverage * 10) / 10,
        ratio: Math.round(ratio * 10) / 10,
      });
    }
  }
  spikes.sort((a, b) => b.ratio - a.ratio);
  return { days, spikes: spikes.slice(0, 5) };
}
