import { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import EpicModel from "../epic/models/epic.model.js";
import TaskModel from "../task/models/task.model.js";
import { approverScope } from "./approval.service.js";
import { AgentActivityModel, type AgentUndoSnapshot } from "./model.js";

/**
 * Undo for agent changes to tasks and epics: the record is snapshotted just
 * before the agent writes, and undo puts that snapshot back (or removes a
 * record the agent created).
 */

/** Raw collections: undo restores documents exactly as they were stored. */
const collectionFor = (entityType: AgentUndoSnapshot["entityType"]) =>
  entityType === "task" ? TaskModel.collection : EpicModel.collection;

const asId = (value: unknown): string | null =>
  typeof value === "string" && Types.ObjectId.isValid(value) ? value : null;

/** Takes a snapshot for a write that targets one task or epic. */
export async function snapshotBefore(
  action: string,
  refs: { taskId?: unknown; epicId?: unknown },
): Promise<AgentUndoSnapshot | null> {
  const taskId = asId(refs.taskId);
  const epicId = asId(refs.epicId);
  const target =
    action.startsWith("epic:") && epicId
      ? { entityType: "epic" as const, entityId: epicId }
      : taskId
        ? { entityType: "task" as const, entityId: taskId }
        : null;
  if (!target || action.endsWith(":create")) return null;
  const before = await collectionFor(target.entityType).findOne({
    _id: new Types.ObjectId(target.entityId),
  });
  return before
    ? { ...target, before: before as Record<string, unknown> }
    : null;
}

/** For creates: remember the new record so undo can remove it. */
export function snapshotCreated(
  action: string,
  result: unknown,
): AgentUndoSnapshot | null {
  if (action !== "task:create" && action !== "epic:create") return null;
  const record = (result as { data?: unknown })?.data ?? result;
  const candidate =
    (record as { task?: unknown; epic?: unknown })?.task ??
    (record as { epic?: unknown })?.epic ??
    record;
  const id =
    (candidate as { _id?: unknown; id?: unknown })?._id ??
    (candidate as { id?: unknown })?.id;
  const entityId = id != null ? String(id) : null;
  if (!entityId || !Types.ObjectId.isValid(entityId)) return null;
  return {
    entityType: action === "task:create" ? "task" : "epic",
    entityId,
    before: null,
  };
}

export async function undoActivity(activityId: string, userId: string) {
  if (!Types.ObjectId.isValid(activityId))
    throw new AppError(404, "Activity not found", "NOT_FOUND");
  const activity = await AgentActivityModel.findById(activityId);
  if (!activity) throw new AppError(404, "Activity not found", "NOT_FOUND");

  const scope = await approverScope(userId);
  const isOwner = activity.userId.toString() === userId;
  const isAdmin =
    activity.workspaceId != null &&
    scope.workspaceIds.some((id) =>
      id.equals(activity.workspaceId as Types.ObjectId),
    );
  if (!isOwner && !isAdmin)
    throw new AppError(404, "Activity not found", "NOT_FOUND");

  const undo = activity.undo;
  if (!undo)
    throw new AppError(400, "This action cannot be undone", "NOT_UNDOABLE");
  if (activity.undoneAt)
    throw new AppError(409, "This action was already undone", "CONFLICT");

  // Claim first so two clicks cannot restore twice.
  const claimed = await AgentActivityModel.findOneAndUpdate(
    { _id: activity._id, undoneAt: null },
    { $set: { undoneAt: new Date(), undoneBy: userId } },
    { new: true },
  );
  if (!claimed)
    throw new AppError(409, "This action was already undone", "CONFLICT");

  const collection = collectionFor(undo.entityType);
  const _id = new Types.ObjectId(undo.entityId);
  try {
    if (undo.before) {
      await collection.replaceOne(
        { _id },
        { ...undo.before, _id },
        { upsert: true },
      );
    } else {
      await collection.deleteOne({ _id });
    }
  } catch (error) {
    await AgentActivityModel.updateOne(
      { _id: activity._id },
      { $set: { undoneAt: null, undoneBy: null } },
    );
    throw error;
  }
  return {
    undone: true,
    entityType: undo.entityType,
    entityId: undo.entityId,
    restored: Boolean(undo.before),
  };
}
