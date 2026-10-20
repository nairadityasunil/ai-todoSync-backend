import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";

import surveyService from "./service.js";
import surveyRepository from "./repository.js";

afterEach(() => {
  mock.restoreAll();
});

test("a retried survey submission returns the stored response", async () => {
  mock.method(surveyRepository, "getSurvey", async () => ({
    _id: "s1",
    questions: [{ id: "q1", type: "NPS", title: "Recommend?" }],
  }));
  const stored = { _id: "r1", answers: [] };
  const lookup = mock.method(
    surveyRepository,
    "findResponseByIdempotencyKey",
    async () => stored,
  );
  const create = mock.method(surveyRepository, "createResponse", async () => {
    throw new Error("must not create a duplicate response");
  });

  const result = await surveyService.submitResponse("tenant", "int1", "s1", {
    answers: { q1: 9 },
    metadata: { idempotencyKey: "run-1" },
  });

  assert.equal(result, stored);
  assert.deepEqual(lookup.mock.calls[0].arguments, ["int1", "s1", "run-1"]);
  assert.equal(create.mock.callCount(), 0);
});
