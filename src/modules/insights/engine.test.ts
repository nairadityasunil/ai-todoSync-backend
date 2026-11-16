import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  bucketStart,
  buckets,
  cohortMembers,
  defaultInterval,
  evaluateAlert,
  funnel,
  matchesFilter,
  paths,
  propertyOf,
  retention,
  sanitizeFilters,
  trends,
  type EventRow,
} from "./engine.js";

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 10, 2); // Monday 2 Nov 2026
const ev = (
  e: string,
  u: string | null,
  t: number,
  p: Record<string, unknown> = {},
  s?: string,
): EventRow => ({ e, u, s: s ?? (u ? `${u}-s` : null), t, p });

describe("properties and filters", () => {
  const row = ev("signup", "ada", T0, {
    plan: "Pro",
    seats: 12,
    address: { country: "IN" },
  });
  test("reads payload fields, dot paths and special properties", () => {
    assert.equal(propertyOf(row, "plan"), "Pro");
    assert.equal(propertyOf(row, "address.country"), "IN");
    assert.equal(propertyOf(row, "$user"), "ada");
    assert.equal(propertyOf(row, "missing.deep"), undefined);
  });
  test("operators: case-insensitive text, numbers, set and not set", () => {
    assert.equal(
      matchesFilter(row, { property: "plan", op: "eq", value: "pro" }),
      true,
    );
    assert.equal(
      matchesFilter(row, { property: "plan", op: "neq", value: "pro" }),
      false,
    );
    assert.equal(
      matchesFilter(row, { property: "plan", op: "contains", value: "R" }),
      true,
    );
    assert.equal(
      matchesFilter(row, { property: "seats", op: "gt", value: 10 }),
      true,
    );
    assert.equal(
      matchesFilter(row, { property: "seats", op: "lt", value: "10" }),
      false,
    );
    assert.equal(
      matchesFilter(row, { property: "plan", op: "gt", value: 1 }),
      false,
    );
    assert.equal(
      matchesFilter(row, { property: "coupon", op: "not_set" }),
      true,
    );
    assert.equal(
      matchesFilter(row, { property: "coupon", op: "neq", value: "x" }),
      true,
    );
  });
  test("bad filters from a request are dropped", () => {
    const f = sanitizeFilters([
      { property: "plan", op: "eq", value: "pro" },
      { property: "", op: "eq" },
      { property: "x", op: "$where" },
      "junk",
    ]);
    assert.deepEqual(f, [{ property: "plan", op: "eq", value: "pro" }]);
  });
});

describe("time buckets", () => {
  test("weeks start on Monday, in UTC", () => {
    const wed = T0 + 2 * D + 5 * H;
    assert.equal(bucketStart(wed, "week"), T0);
    assert.equal(bucketStart(T0 - 1, "week"), T0 - 7 * D);
    assert.equal(bucketStart(T0 + 5 * H + 1, "hour"), T0 + 5 * H);
  });
  test("every bucket in the range is present, so gaps show as zero", () => {
    assert.equal(buckets(T0, T0 + 6 * D, "day").length, 7);
    assert.equal(defaultInterval(T0, T0 + D), "hour");
    assert.equal(defaultInterval(T0, T0 + 30 * D), "day");
    assert.equal(defaultInterval(T0, T0 + 180 * D), "week");
  });
});

describe("trends", () => {
  const rows = [
    ev("view", "a", T0 + H),
    ev("view", "a", T0 + 2 * H),
    ev("view", "b", T0 + D + H),
    ev("view", "a", T0 + D + 2 * H),
    ev("click", "a", T0 + H),
  ];
  test("totals and unique users per bucket; unique totals are not summed across buckets", () => {
    const r = trends(rows, {
      series: [
        { event: "view", math: "total" },
        { event: "view", math: "unique_users" },
      ],
      from: T0,
      to: T0 + 2 * D - 1,
      interval: "day",
    });
    assert.deepEqual(
      r.series[0].points.map((p) => p.value),
      [2, 2],
    );
    assert.equal(r.series[0].total, 4);
    assert.deepEqual(
      r.series[1].points.map((p) => p.value),
      [1, 2],
    );
    assert.equal(r.series[1].total, 2);
  });
  test("breakdown by a property, with the long tail folded into Other", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 12 - i }, () =>
        ev("view", `u${i}`, T0 + H, { country: `C${i}` }),
      ),
    ).flat();
    const r = trends(many, {
      series: [{ event: "view", math: "total" }],
      from: T0,
      to: T0 + D - 1,
      interval: "day",
      breakdown: "country",
    });
    assert.equal(r.series.length, 8);
    assert.equal(r.series[0].breakdownValue, "C0");
    assert.equal(r.series[7].breakdownValue, "Other");
    assert.equal(
      r.series.reduce((s, x) => s + x.total, 0),
      many.length,
    );
    assert.equal(r.otherFolded, 5);
  });
  test("sum and average of a numeric property; non-numbers are skipped", () => {
    const money = [
      ev("buy", "a", T0 + H, { amount: 10 }),
      ev("buy", "b", T0 + 2 * H, { amount: "5.5" }),
      ev("buy", "c", T0 + 3 * H, { amount: "n/a" }),
    ];
    const r = trends(money, {
      series: [
        { event: "buy", math: "sum", property: "amount" },
        { event: "buy", math: "average", property: "amount" },
      ],
      from: T0,
      to: T0 + D - 1,
      interval: "day",
    });
    assert.equal(r.series[0].total, 15.5);
    assert.equal(r.series[1].total, 7.75);
    assert.equal(r.series[0].label, "buy (sum of amount)");
  });
  test("events outside the range or failing a filter are left out", () => {
    const r = trends(
      [
        ...rows,
        ev("view", "z", T0 - 1),
        ev("view", "c", T0 + 3 * H, { plan: "free" }),
      ],
      {
        series: [
          {
            event: "view",
            math: "total",
            filters: [{ property: "plan", op: "neq", value: "free" }],
          },
        ],
        from: T0,
        to: T0 + 2 * D - 1,
        interval: "day",
      },
    );
    assert.equal(r.series[0].total, 4);
  });
});

describe("funnels", () => {
  const steps = [{ event: "visit" }, { event: "signup" }, { event: "pay" }];
  test("ordered steps within the window; counts, conversion and drop-off", () => {
    const rows = [
      ev("visit", "a", T0),
      ev("signup", "a", T0 + H),
      ev("pay", "a", T0 + 3 * H),
      ev("visit", "b", T0),
      ev("signup", "b", T0 + 2 * H),
      ev("visit", "c", T0),
      ev("pay", "c", T0 + H),
      ev("signup", "d", T0),
      ev("visit", "d", T0 + H),
    ];
    const r = funnel(rows, { steps, windowMs: D, from: T0, to: T0 + 7 * D });
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [4, 2, 1],
    );
    assert.equal(r.steps[1].conversionFromPrevious, 0.5);
    assert.equal(r.steps[2].dropped, 1);
    assert.equal(r.steps[1].medianMsFromPrevious, 1.5 * H);
    assert.equal(r.converted, 1);
  });
  test("steps outside the window do not count", () => {
    const r = funnel([ev("visit", "a", T0), ev("signup", "a", T0 + 2 * D)], {
      steps,
      windowMs: D,
      from: T0,
      to: T0 + 7 * D,
    });
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [1, 0, 0],
    );
  });
  test("a later attempt that gets further wins", () => {
    const r = funnel(
      [
        ev("visit", "a", T0),
        ev("visit", "a", T0 + 3 * D),
        ev("signup", "a", T0 + 3 * D + H),
        ev("pay", "a", T0 + 3 * D + 2 * H),
      ],
      { steps, windowMs: D, from: T0, to: T0 + 7 * D },
    );
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [1, 1, 1],
    );
  });
  test("the same event twice in a row counts as two steps only if it happens twice", () => {
    const twice = [{ event: "view" }, { event: "view" }];
    assert.deepEqual(
      funnel([ev("view", "a", T0)], {
        steps: twice,
        windowMs: D,
        from: T0,
        to: T0 + D,
      }).steps.map((s) => s.count),
      [1, 0],
    );
    assert.deepEqual(
      funnel([ev("view", "a", T0), ev("view", "a", T0 + H)], {
        steps: twice,
        windowMs: D,
        from: T0,
        to: T0 + D,
      }).steps.map((s) => s.count),
      [1, 1],
    );
  });
  test("people enter only inside the range but may finish after it, within the window", () => {
    const rows = [
      ev("visit", "a", T0 + 6 * D),
      ev("signup", "a", T0 + 7 * D + H),
      ev("visit", "b", T0 + 8 * D),
      ev("signup", "b", T0 + 8 * D + H),
    ];
    const r = funnel(rows, {
      steps: [{ event: "visit" }, { event: "signup" }],
      windowMs: 2 * D,
      from: T0,
      to: T0 + 9 * D,
      entryTo: T0 + 7 * D,
    });
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [1, 1],
    );
  });
  test("anonymous events are not people", () => {
    assert.equal(
      funnel([ev("visit", null, T0), ev("signup", null, T0 + H)], {
        steps,
        windowMs: D,
        from: T0,
        to: T0 + D,
      }).entered,
      0,
    );
  });
});

describe("retention", () => {
  test("cohorts by first start; later periods count returns; future periods are empty", () => {
    const rows = [
      ev("signup", "a", T0 + H),
      ev("open", "a", T0 + D + H),
      ev("open", "a", T0 + 2 * D + H),
      ev("signup", "b", T0 + 2 * H),
      ev("open", "b", T0 + 2 * D + H),
      ev("signup", "c", T0 + D + H),
      ev("open", "c", T0 + D + 2 * H),
    ];
    const r = retention(rows, {
      startEvent: "signup",
      returnEvent: "open",
      period: "day",
      periods: 4,
      from: T0,
      to: T0 + 3 * D,
      now: T0 + 2 * D + 12 * H,
    });
    assert.equal(r.cohorts.length, 2);
    assert.equal(r.cohorts[0].size, 2);
    assert.deepEqual(r.cohorts[0].counts, [0, 1, 2, null]);
    assert.deepEqual(r.cohorts[1].counts, [1, 0, null, null]);
    assert.equal(r.average[1], 1 / 3);
  });
  test("when start and return are the same event, the first one is not its own return", () => {
    const r = retention([ev("open", "a", T0 + H)], {
      startEvent: "open",
      returnEvent: "open",
      period: "day",
      periods: 2,
      from: T0,
      to: T0 + D,
      now: T0 + 3 * D,
    });
    assert.deepEqual(r.cohorts[0].counts, [0, 0]);
  });
});

describe("paths", () => {
  test("next steps per session, repeats collapsed, from a start event", () => {
    const rows = [
      ev("home", "a", T0, {}, "s1"),
      ev("home", "a", T0 + 1, {}, "s1"),
      ev("pricing", "a", T0 + 2, {}, "s1"),
      ev("signup", "a", T0 + 3, {}, "s1"),
      ev("home", "b", T0, {}, "s2"),
      ev("pricing", "b", T0 + 1, {}, "s2"),
      ev("docs", "b", T0 + 2, {}, "s2"),
      ev("docs", "c", T0, {}, "s3"),
      ev("home", "c", T0 + 1, {}, "s3"),
      ev("blog", "c", T0 + 2, {}, "s3"),
    ];
    const r = paths(rows, {
      startEvent: "home",
      depth: 2,
      from: T0,
      to: T0 + D,
    });
    assert.equal(r.sessions, 3);
    const first = r.edges.filter((e) => e.step === 0);
    assert.deepEqual(
      first.map((e) => `${e.from}>${e.to}:${e.count}`),
      ["home>pricing:2", "home>blog:1"],
    );
    const second = r.edges.filter((e) => e.step === 1);
    assert.deepEqual(
      second.map((e) => `${e.from}>${e.to}:${e.count}`),
      ["pricing>docs:1", "pricing>signup:1"],
    );
  });
});

describe("cohorts", () => {
  const rows = [
    ev("purchase", "a", T0 - 2 * D, { plan: "free" }),
    ev("purchase", "a", T0 - D, { plan: "pro" }),
    ev("purchase", "b", T0 - 40 * D, { plan: "pro" }),
    ev("login", "c", T0 - D, { plan: "pro" }),
  ];
  test("did at least N times within days, did not, and the latest property value", () => {
    assert.deepEqual(
      cohortMembers(
        rows,
        {
          match: "all",
          rules: [{ kind: "did", event: "purchase", count: 2, withinDays: 30 }],
        },
        T0,
      ),
      ["a"],
    );
    assert.deepEqual(
      cohortMembers(
        rows,
        {
          match: "all",
          rules: [{ kind: "did_not", event: "purchase", withinDays: 30 }],
        },
        T0,
      ),
      ["b", "c"],
    );
    assert.deepEqual(
      cohortMembers(
        rows,
        {
          match: "all",
          rules: [],
          properties: [{ property: "plan", op: "eq", value: "pro" }],
        },
        T0,
      ),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      cohortMembers(
        rows,
        {
          match: "any",
          rules: [
            { kind: "did", event: "login", withinDays: 7 },
            { kind: "did", event: "purchase", count: 2, withinDays: 7 },
          ],
        },
        T0,
      ),
      ["a", "c"],
    );
  });
});

describe("alerts", () => {
  test("thresholds and percentage change", () => {
    assert.equal(
      evaluateAlert({ condition: "above", threshold: 10 }, 11, null).firing,
      true,
    );
    assert.equal(
      evaluateAlert({ condition: "below", threshold: 10 }, 10, null).firing,
      false,
    );
    assert.equal(
      evaluateAlert({ condition: "change_down", threshold: 30 }, 60, 100)
        .firing,
      true,
    );
    assert.equal(
      evaluateAlert({ condition: "change_up", threshold: 50 }, 140, 100).firing,
      false,
    );
    assert.equal(
      evaluateAlert({ condition: "change_up", threshold: 50 }, 140, 0).firing,
      false,
    );
    assert.match(
      evaluateAlert({ condition: "change_down", threshold: 30 }, 60, 100)
        .detail,
      /down 40% from 100/,
    );
  });
});
