import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { mergeTimeline, type TimelineItem } from "./timeline-merge.js";

const item = (id: string, at: string, kind: TimelineItem["kind"] = "work"): TimelineItem => ({
  id,
  kind,
  at,
  title: id,
  actor: { type: "person", name: "A" },
});

describe("unified timeline", () => {
  test("merges sources newest first and keeps the limit", () => {
    const merged = mergeTimeline(
      [
        [item("w1", "2026-11-03T10:00:00.000Z"), item("w2", "2026-11-01T10:00:00.000Z")],
        [item("a1", "2026-11-02T10:00:00.000Z", "agent")],
        [item("e1", "2026-11-03T11:00:00.000Z", "event")],
      ],
      3,
    );
    assert.deepEqual(merged.map((i) => i.id), ["e1", "w1", "a1"]);
  });

  test("equal times sort by id so pages are stable", () => {
    const t = "2026-11-03T10:00:00.000Z";
    assert.deepEqual(mergeTimeline([[item("a", t)], [item("b", t)]], 5).map((i) => i.id), ["b", "a"]);
  });
});
