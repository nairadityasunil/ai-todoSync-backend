import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  AUTOMATION_RULES,
  DEFAULT_AUTOMATION,
  describeTask,
  droppedBy,
  formatMetric,
  normalizeAutomation,
  outcomeOf,
  ruleOn,
  spiked,
  toFivePoint,
  worstStep,
} from "./automation.js";

describe("automation settings", () => {
  test("missing settings mean every rule is on with the default thresholds", () => {
    const s = normalizeAutomation(undefined);
    assert.deepEqual(s, DEFAULT_AUTOMATION);
    assert.equal(Object.keys(s.rules).length, AUTOMATION_RULES.length);
  });

  test("bad values fall back or are clamped; unknown rules are dropped", () => {
    const s = normalizeAutomation({
      dropOffThreshold: 9,
      minSample: 1,
      surveyScoreThreshold: "x",
      remeasureDays: 500,
      eventRetentionDays: 45,
      projectId: "nope",
      rules: { shadow_ai: false, made_up: true },
    });
    assert.equal(s.dropOffThreshold, 0.95);
    assert.equal(s.minSample, 5);
    assert.equal(s.surveyScoreThreshold, 3.5);
    assert.equal(s.remeasureDays, 90);
    assert.equal(s.eventRetentionDays, 0);
    assert.equal(s.projectId, null);
    assert.equal(s.rules.shadow_ai, false);
    assert.equal("made_up" in s.rules, false);
  });

  test("the master switch turns every rule off", () => {
    const s = normalizeAutomation({ enabled: false });
    assert.equal(ruleOn(s, "incident"), false);
    assert.equal(
      ruleOn(normalizeAutomation({ rules: { incident: false } }), "incident"),
      false,
    );
    assert.equal(ruleOn(normalizeAutomation({}), "incident"), true);
  });
});

describe("telemetry rules", () => {
  const step = (reached: number, dropped: number) => ({
    reached,
    dropped,
    dropOffRate: reached ? dropped / reached : 0,
  });

  test("the worst step over the threshold is picked; small samples and the last step are ignored", () => {
    const steps = [step(100, 20), step(80, 44), step(36, 30)];
    assert.equal(worstStep(steps, 0.4, 20), steps[1]);
    assert.equal(
      worstStep([step(100, 20), step(80, 20), step(60, 60)], 0.4, 20),
      null,
    );
    assert.equal(worstStep([step(10, 9), step(1, 1)], 0.4, 20), null);
  });

  test("a relative fall of 30% counts as a drop", () => {
    assert.equal(droppedBy(0.6, 0.42, 0.3), true);
    assert.equal(droppedBy(0.6, 0.5, 0.3), false);
    assert.equal(droppedBy(0, 0, 0.3), false);
  });

  test("ten times the usual volume is a spike, above a floor", () => {
    assert.equal(spiked(100, 1000, 10, 200), true);
    assert.equal(spiked(100, 900, 10, 200), false);
    assert.equal(spiked(5, 60, 10, 200), false);
    assert.equal(spiked(0, 5000, 10, 200), false);
  });

  test("survey answers on any scale map to 1-5", () => {
    assert.equal(toFivePoint(5, 1, 5), 5);
    assert.equal(toFivePoint(0, 0, 10), 1);
    assert.equal(toFivePoint(5, 0, 10), 3);
    assert.equal(toFivePoint(99, 1, 5), 5);
    assert.equal(toFivePoint(Number.NaN, 1, 5), null);
    assert.equal(toFivePoint(3, 5, 5), null);
  });
});

describe("feedback loop", () => {
  test("improvement depends on which direction is better", () => {
    assert.equal(outcomeOf(0.45, 0.28, true), "improved");
    assert.equal(outcomeOf(0.45, 0.6, true), "worse");
    assert.equal(outcomeOf(3.1, 4.2, false), "improved");
    assert.equal(outcomeOf(3.1, 2.5, false), "worse");
    assert.equal(outcomeOf(0.45, 0.46, true), "unchanged");
  });

  test("metrics and task text read plainly", () => {
    assert.equal(formatMetric("percent", 0.452), "45%");
    assert.equal(formatMetric("score", 3.14), "3.1");
    assert.equal(formatMetric("count", 7), "7");
    const text = describeTask(
      {
        description: "Half the people leave.",
        link: "/sdk-integrations/1/guides?analytics=2",
      },
      "https://app.example.com/",
    );
    assert.match(text, /Opened automatically by Pristine/);
    assert.match(
      text,
      /https:\/\/app\.example\.com\/sdk-integrations\/1\/guides\?analytics=2/,
    );
  });
});
