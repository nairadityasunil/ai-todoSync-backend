import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { stepFunnel } from "./step-funnel.js";

const steps = [
  { id: "s1", title: "Welcome" },
  { id: "s2", title: "Pick a plan" },
  { id: "s3", title: "Invite team" },
];

describe("guide step funnel", () => {
  test("completers reach every step; others stop where they were", () => {
    const funnel = stepFunnel(steps, [
      { status: "completed", currentStepId: "s3" },
      { status: "completed", currentStepId: null },
      { status: "dismissed", currentStepId: "s2" },
      { status: "dismissed", currentStepId: "s2" },
      { status: "shown", currentStepId: null },
    ]);
    assert.deepEqual(
      funnel.map(({ reached, dropped }) => [reached, dropped]),
      [
        [5, 1],
        [4, 2],
        [2, 0],
      ],
    );
    assert.equal(funnel[1].dropOffRate, 0.5);
    assert.equal(funnel[1].title, "Pick a plan");
  });

  test("an unknown step id counts as the first step; no steps gives no funnel", () => {
    assert.equal(stepFunnel(steps, [{ status: "abandoned", currentStepId: "gone" }])[0].dropped, 1);
    assert.deepEqual(stepFunnel([], [{ status: "completed" }]), []);
  });
});
