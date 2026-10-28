import AnalyticsLogModel from "../models/analytics-log.model.js";
import { TRAFFIC_TYPES, type TrafficType } from "../traffic.js";

/**
 * How much of an SDK integration's traffic comes from AI agents, other
 * automation and crawlers, and which pages AI agents read. Events recorded
 * before classification existed count as "unclassified".
 */

const DAY = 86400000;
export const MAX_TRAFFIC_DAYS = 90;

type Bucket = TrafficType | "unclassified";

const bucketOf = (value: unknown): Bucket =>
  TRAFFIC_TYPES.includes(value as TrafficType)
    ? (value as TrafficType)
    : "unclassified";

/** "https://x.com/a?b=1#c" -> "https://x.com/a": pages, not visits. */
export const pageKey = (url: unknown): string | null => {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0].slice(0, 300);
  }
};

class AiTrafficService {
  /** Events per day and type, counted from the rows (stores without date operators). */
  private async dailyFromRows(match: Record<string, unknown>) {
    const logs = await AnalyticsLogModel.find(match)
      .select("createdAt payload.traffic.type")
      .limit(100_000)
      .lean();
    const counts = new Map<
      string,
      { _id: { day: string; type: unknown }; events: number }
    >();
    for (const log of logs) {
      const day = new Date(log.createdAt).toISOString().slice(0, 10);
      const type = (log.payload as { traffic?: { type?: unknown } })?.traffic
        ?.type;
      const key = `${day}:${String(type)}`;
      const row = counts.get(key) ?? { _id: { day, type }, events: 0 };
      row.events += 1;
      counts.set(key, row);
    }
    return [...counts.values()];
  }

  public async report(
    sdkIntegrationId: string,
    days: number,
    now = new Date(),
  ) {
    const span = Math.min(
      Math.max(Math.round(days) || 30, 1),
      MAX_TRAFFIC_DAYS,
    );
    const since = new Date(now.getTime() - span * DAY);
    const match = { sdkIntegrationId, createdAt: { $gte: since } };

    const [byType, sessionsByType, byAgent, byDay, aiPages] = await Promise.all(
      [
        AnalyticsLogModel.aggregate<{ _id: unknown; events: number }>([
          { $match: match },
          { $group: { _id: "$payload.traffic.type", events: { $sum: 1 } } },
        ]),
        AnalyticsLogModel.aggregate<{ _id: unknown; sessions: number }>([
          { $match: { ...match, sessionId: { $type: "string" } } },
          {
            $group: {
              _id: { type: "$payload.traffic.type", session: "$sessionId" },
            },
          },
          { $group: { _id: "$_id.type", sessions: { $sum: 1 } } },
        ]),
        AnalyticsLogModel.aggregate<{
          _id: { type: unknown; agent: unknown };
          events: number;
        }>([
          {
            $match: {
              ...match,
              "payload.traffic.type": { $in: ["ai_agent", "crawler"] },
            },
          },
          {
            $group: {
              _id: {
                type: "$payload.traffic.type",
                agent: "$payload.traffic.agent",
              },
              events: { $sum: 1 },
            },
          },
          { $sort: { events: -1 } },
          { $limit: 20 },
        ]),
        AnalyticsLogModel.aggregate<{
          _id: { day: string; type: unknown };
          events: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: {
                day: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                },
                type: "$payload.traffic.type",
              },
              events: { $sum: 1 },
            },
          },
        ]).catch(() => this.dailyFromRows(match)),
        AnalyticsLogModel.find({ ...match, "payload.traffic.type": "ai_agent" })
          .select("payload.context.page.url payload.url payload.traffic.agent")
          .sort({ createdAt: -1 })
          .limit(2000)
          .lean(),
      ],
    );

    const totals = Object.fromEntries(
      [...TRAFFIC_TYPES, "unclassified"].map((type) => [
        type,
        { events: 0, sessions: 0 },
      ]),
    ) as Record<Bucket, { events: number; sessions: number }>;
    for (const row of byType) totals[bucketOf(row._id)].events += row.events;
    for (const row of sessionsByType)
      totals[bucketOf(row._id)].sessions += row.sessions;
    const classified = TRAFFIC_TYPES.reduce(
      (sum, type) => sum + totals[type].events,
      0,
    );

    const perDay: Record<string, Record<Bucket, number>> = {};
    for (const row of byDay) {
      const day = (perDay[row._id.day] ??= {
        human: 0,
        ai_agent: 0,
        automated: 0,
        crawler: 0,
        unclassified: 0,
      });
      day[bucketOf(row._id.type)] += row.events;
    }
    const daily = Array.from({ length: span }, (_, i) => {
      const date = new Date(since.getTime() + (i + 1) * DAY)
        .toISOString()
        .slice(0, 10);
      const day = perDay[date];
      return {
        date,
        human: day?.human ?? 0,
        aiAgent: day?.ai_agent ?? 0,
        automated: day?.automated ?? 0,
        crawler: day?.crawler ?? 0,
      };
    });

    const pages = new Map<string, { events: number; agents: Set<string> }>();
    for (const log of aiPages) {
      const payload = (log.payload ?? {}) as {
        url?: unknown;
        context?: { page?: { url?: unknown } };
        traffic?: { agent?: unknown };
      };
      const key = pageKey(payload.context?.page?.url ?? payload.url);
      if (!key) continue;
      const page = pages.get(key) ?? { events: 0, agents: new Set<string>() };
      page.events += 1;
      if (typeof payload.traffic?.agent === "string")
        page.agents.add(payload.traffic.agent);
      pages.set(key, page);
    }

    return {
      days: span,
      since: since.toISOString(),
      totals,
      /** Share of classified events made by AI agents, 0-100. */
      aiAgentShare: classified
        ? (totals.ai_agent.events / classified) * 100
        : 0,
      agents: byAgent.map((row) => ({
        type: bucketOf(row._id.type),
        agent: typeof row._id.agent === "string" ? row._id.agent : "Unnamed",
        events: row.events,
      })),
      daily,
      aiPages: [...pages.entries()]
        .map(([url, page]) => ({
          url,
          events: page.events,
          agents: [...page.agents].sort(),
        }))
        .sort((a, b) => b.events - a.events)
        .slice(0, 10),
    };
  }
}

export default new AiTrafficService();
