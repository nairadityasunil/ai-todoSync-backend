import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { buildEventTrend } from "./trend.js";

const now = new Date("2026-11-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

describe("event trend", () => {
  test("counts per UTC day, oldest first, with empty days", () => {
    const { days } = buildEventTrend(
      [
        { createdAt: hoursAgo(1), eventName: "a" },
        { createdAt: hoursAgo(2), eventName: "a" },
        { createdAt: hoursAgo(30), eventName: "b" },
      ],
      { days: 3, now },
    );
    assert.deepEqual(days, [
      { date: "2026-11-01", count: 0 },
      { date: "2026-11-02", count: 1 },
      { date: "2026-11-03", count: 2 },
    ]);
  });

  test("flags an event that jumps well above its usual daily volume", () => {
    const logs = [
      ...Array.from({ length: 30 }, () => ({ createdAt: hoursAgo(2), eventName: "checkout_failed" })),
      ...Array.from({ length: 14 }, (_, i) => ({ createdAt: hoursAgo(30 + i * 10), eventName: "checkout_failed" })),
      ...Array.from({ length: 12 }, () => ({ createdAt: hoursAgo(3), eventName: "page_view" })),
      ...Array.from({ length: 84 }, (_, i) => ({ createdAt: hoursAgo(26 + i * 1.5), eventName: "page_view" })),
    ];
    const { spikes } = buildEventTrend(logs, { days: 14, now });
    assert.equal(spikes.length, 1);
    assert.equal(spikes[0].eventName, "checkout_failed");
    assert.equal(spikes[0].last24h, 30);
    assert.equal(spikes[0].dailyAverage, 2);
  });

  test("ignores small counts", () => {
    const logs = Array.from({ length: 5 }, () => ({ createdAt: hoursAgo(1), eventName: "x" }));
    assert.deepEqual(buildEventTrend(logs, { days: 7, now }).spikes, []);
  });
});
