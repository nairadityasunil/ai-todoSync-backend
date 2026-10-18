import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";

import taskService from "./task.service.js";
import TaskModel from "../models/task.model.js";
import ProjectMemberModel from "../../project/models/project-member.model.js";
import slaService from "./sla.service.js";
import priorityEngineService from "./priority-engine.service.js";

const query = (result: unknown) => {
  const chain = {
    populate: () => chain,
    sort: () => chain,
    select: () => chain,
    lean: () => chain,
    exec: async () => result,
    then: (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return chain as any;
};

const memberId = new Types.ObjectId();
const creatorId = new Types.ObjectId();
const projectId = new Types.ObjectId();

const makeTask = () => ({
  _id: new Types.ObjectId(),
  userId: creatorId,
  projectId,
  epicId: null,
  assignedTo: creatorId,
  title: "Ship it",
  status: "TODO",
  subtasks: [],
  isBlocked: false,
});

let lastUpdate: Record<string, unknown> | null = null;

const stubCommon = (task: ReturnType<typeof makeTask>, role: "ADMIN" | "MEMBER") => {
  mock.method(ProjectMemberModel, "find", () =>
    query([{ projectId, userId: memberId, role }]),
  );
  mock.method(TaskModel, "findOne", () => query(task));
  mock.method(TaskModel, "findByIdAndUpdate", (_id: unknown, update: Record<string, unknown>) => {
    lastUpdate = update;
    return query({ ...task, ...update });
  });
  mock.method(slaService, "applyPriorityChange", async (_u: unknown, _t: unknown, u: unknown) => u);
  mock.method(slaService, "applyStatusTransition", (_t: unknown, u: unknown) => u);
  mock.method(priorityEngineService, "evaluateAndPersist", async () => undefined);
};

afterEach(() => {
  mock.restoreAll();
  lastUpdate = null;
});

describe("Task update permissions", () => {
  test("drops server-managed fields such as userId and SLA flags", async () => {
    const task = makeTask();
    stubCommon(task, "MEMBER");

    await taskService.updateTask(task._id.toString(), memberId.toString(), {
      status: "IN_PROGRESS",
      userId: memberId.toString(),
      responseBreached: false,
      dynamicPriorityScore: 999,
    } as any);

    assert.ok(lastUpdate);
    assert.equal(lastUpdate!.status, "IN_PROGRESS");
    assert.equal("userId" in lastUpdate!, false);
    assert.equal("responseBreached" in lastUpdate!, false);
    assert.equal("dynamicPriorityScore" in lastUpdate!, false);
  });

  test("a plain member cannot reassign someone else's task", async () => {
    const task = makeTask();
    stubCommon(task, "MEMBER");

    await assert.rejects(
      taskService.updateTask(task._id.toString(), memberId.toString(), {
        assignedTo: memberId.toString(),
      } as any),
      /reassignment not allowed/,
    );
    assert.equal(lastUpdate, null);
  });

  test("an admin can only reassign to a project member", async () => {
    const task = makeTask();
    stubCommon(task, "ADMIN");
    mock.method(ProjectMemberModel, "exists", async () => null);

    await assert.rejects(
      taskService.updateTask(task._id.toString(), memberId.toString(), {
        assignedTo: new Types.ObjectId().toString(),
      } as any),
      /must be a project member/,
    );
  });
});
