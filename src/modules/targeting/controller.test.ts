import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import targetingController from "./controller.js";
import targetingService from "./service.js";

const makeRes = () => {
  const captured: { statusCode: number; body: any } = {
    statusCode: 0,
    body: undefined,
  };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
};

const makeReq = (body: unknown, params: Record<string, string> = {}) =>
  ({
    user: { _id: "user-1" },
    body,
    params,
  }) as unknown as Request;

const validRules = { operator: "AND", conditions: [], groups: [] };

afterEach(() => {
  mock.restoreAll();
});

describe("Targeting segments controller", () => {
  test("maps a duplicate segment name to 409", async () => {
    mock.method(targetingService, "createSegment", async () => {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    });
    const { res, captured } = makeRes();

    await targetingController.createSegment(
      makeReq({ name: "Admins", rules: validRules }),
      res,
    );

    assert.equal(captured.statusCode, 409);
    assert.equal(captured.body.code, "DUPLICATE_SEGMENT");
  });

  test("maps a malformed segment id to 404", async () => {
    mock.method(targetingService, "deleteSegment", async () => {
      throw Object.assign(new Error("Cast to ObjectId failed"), {
        name: "CastError",
      });
    });
    const { res, captured } = makeRes();

    await targetingController.deleteSegment(
      makeReq({}, { segmentId: "not-an-id" }),
      res,
    );

    assert.equal(captured.statusCode, 404);
  });

  test("rejects a segment without a name with 400", async () => {
    const create = mock.method(targetingService, "createSegment");
    const { res, captured } = makeRes();

    await targetingController.createSegment(
      makeReq({ name: "  ", rules: validRules }),
      res,
    );

    assert.equal(captured.statusCode, 400);
    assert.equal(create.mock.callCount(), 0);
  });
});
