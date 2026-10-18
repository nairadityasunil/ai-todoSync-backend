import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

import surveyService from "./service.js";
import surveyRepository from "./repository.js";
import { GuideExposureModel } from "../engagement/model.js";

afterEach(() => {
  mock.restoreAll();
});

describe("Survey analytics", () => {
  test("counts each selected option of a multiple-choice answer", async () => {
    mock.method(surveyRepository, "getSurvey", async () => ({
      _id: "s1",
      questions: [
        { id: "q1", type: "MULTI_CHOICE", title: "Which features?" },
        { id: "q2", type: "NPS", title: "Recommend?" },
      ],
    }));
    mock.method(surveyRepository, "listResponses", async () => [
      {
        answers: [
          { questionId: "q1", value: ["Tasks", "Chat"] },
          { questionId: "q2", value: 10 },
        ],
        category: "PROMOTER",
        submittedAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        answers: [{ questionId: "q1", value: ["Tasks"] }],
        category: null,
        submittedAt: new Date("2026-10-02T00:00:00Z"),
      },
    ]);
    mock.method(GuideExposureModel, "find", () => ({ exec: async () => [] }));

    const analytics = await surveyService.getSurveyAnalytics("t1", "i1", "s1");
    const multi = analytics.questionAnalytics.find(
      (question) => question.questionId === "q1",
    );

    assert.deepEqual(multi?.distribution, { Tasks: 2, Chat: 1 });
    assert.equal(multi?.responseCount, 2);
    assert.equal(analytics.promoters, 1);
  });
});
