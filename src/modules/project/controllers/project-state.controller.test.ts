import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { Types } from "mongoose";

import ProjectModel from "../models/project.model.js";
import projectService from "../services/project.service.js";
import { AppError } from "../../../utils/app-error.js";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import {
  createProjectState,
  getProjectStates,
  reorderProjectStates,
  updateProjectState,
} from "./project-state.controller.js";

interface CapturedResponse {
  statusCode: number;
  body: any;
}

const makeRes = (): { res: Response; captured: CapturedResponse } => {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };
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

const makeReq = (
  params: Record<string, string>,
  body: Record<string, unknown> = {},
): AuthenticatedRequest =>
  ({
    user: { _id: new Types.ObjectId() },
    params,
    body,
  }) as unknown as AuthenticatedRequest;

const makeProject = (names: string[]) => {
  const project = {
    states: names.map((name, position) => ({
      _id: new Types.ObjectId(),
      name,
      color: "#3B82F6",
      category: "STARTED",
      position,
    })),
    save: mock.fn(async () => project),
    markModified: mock.fn(),
  };
  return project;
};

const projectId = new Types.ObjectId().toString();

afterEach(() => {
  mock.restoreAll();
});

describe("Project workflow states controller", () => {
  test("rejects an unknown category with 400 before touching the project", async () => {
    mock.method(projectService, "assertProjectRole", async () => undefined);
    const findById = mock.method(ProjectModel, "findById", async () =>
      makeProject([]),
    );
    const { res, captured } = makeRes();

    await createProjectState(
      makeReq({ id: projectId }, { name: "QA", category: "WAITING" }),
      res,
    );

    assert.equal(captured.statusCode, 400);
    assert.match(captured.body.error, /Category must be one of/);
    assert.equal(findById.mock.callCount(), 0);
  });

  test("rejects a non-hex color with 400", async () => {
    mock.method(projectService, "assertProjectRole", async () => undefined);
    const { res, captured } = makeRes();

    await createProjectState(
      makeReq({ id: projectId }, { name: "QA", color: "blue" }),
      res,
    );

    assert.equal(captured.statusCode, 400);
  });

  test("rejects a duplicate state name (case-insensitive) with 409", async () => {
    mock.method(projectService, "assertProjectRole", async () => undefined);
    mock.method(ProjectModel, "findById", async () =>
      makeProject(["Backlog", "Done"]),
    );
    const { res, captured } = makeRes();

    await createProjectState(
      makeReq({ id: projectId }, { name: "  done " }),
      res,
    );

    assert.equal(captured.statusCode, 409);
  });

  test("creates a valid state at the end of the workflow", async () => {
    mock.method(projectService, "assertProjectRole", async () => undefined);
    const project = makeProject(["Backlog"]);
    mock.method(ProjectModel, "findById", async () => project);
    const { res, captured } = makeRes();

    await createProjectState(
      makeReq(
        { id: projectId },
        { name: " Review ", color: "#8B5CF6", category: "STARTED" },
      ),
      res,
    );

    assert.equal(captured.statusCode, 201);
    assert.equal(captured.body.state.name, "Review");
    assert.equal(captured.body.state.position, 1);
    assert.equal(project.save.mock.callCount(), 1);
  });

  test("returns the AppError status instead of 500 when access is denied", async () => {
    mock.method(projectService, "assertProjectMembership", async () => {
      throw new AppError(403, "Not a project member", "FORBIDDEN");
    });
    const { res, captured } = makeRes();

    await getProjectStates(makeReq({ id: projectId }), res);

    assert.equal(captured.statusCode, 403);
  });

  test("does not allow renaming a state to another state's name", async () => {
    mock.method(projectService, "assertProjectRole", async () => undefined);
    const project = makeProject(["Backlog", "Done"]);
    mock.method(ProjectModel, "findById", async () => project);
    const { res, captured } = makeRes();

    await updateProjectState(
      makeReq(
        { id: projectId, stateId: project.states[0]._id.toString() },
        { name: "Done" },
      ),
      res,
    );

    assert.equal(captured.statusCode, 409);
  });

  test("reorder requires every state exactly once", async () => {
    mock.method(projectService, "assertProjectRole", async () => undefined);
    const project = makeProject(["Backlog", "Doing", "Done"]);
    mock.method(ProjectModel, "findById", async () => project);
    const ids = project.states.map((s) => s._id.toString());

    const partial = makeRes();
    await reorderProjectStates(
      makeReq({ id: projectId }, { stateIds: [ids[1], ids[0]] }),
      partial.res,
    );
    assert.equal(partial.captured.statusCode, 400);

    const full = makeRes();
    await reorderProjectStates(
      makeReq({ id: projectId }, { stateIds: [ids[2], ids[0], ids[1]] }),
      full.res,
    );
    assert.equal(full.captured.statusCode, 200);
    assert.deepEqual(
      full.captured.body.states.map((s: { name: string }) => s.name),
      ["Done", "Backlog", "Doing"],
    );
  });
});
