import { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import EpicModel from "../epic/models/epic.model.js";
import ProjectMemberModel from "../project/models/project-member.model.js";
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

/**
 * Whether a user may change a task or epic: a member of its project, or for a
 * personal task (no project) the person it belongs to.
 */
async function canEditRecord(
  userId: string,
  doc: Record<string, unknown>,
): Promise<boolean> {
  const projectId = doc.projectId ? String(doc.projectId) : null;
  if (!projectId) return String(doc.userId ?? "") === userId;
  if (!Types.ObjectId.isValid(projectId)) return false;
  const member = await ProjectMemberModel.exists({
    projectId: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  });
  return Boolean(member);
}

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

  // The caller must be allowed to edit the record as it is now and as it
  // will be after the undo, whoever owned the agent.
  const _id = new Types.ObjectId(undo.entityId);
  const collection = collectionFor(undo.entityType);
  const current = await collection.findOne({ _id });
  // A record that is gone can only come back when the agent deleted it. (An
  // undone create whose record is already gone needs no change.)
  if (!current && undo.before && !activity.action.endsWith(":delete")) {
    throw new AppError(
      409,
      "The record no longer exists, so this change cannot be undone",
      "CONFLICT",
    );
  }
  for (const doc of [current, undo.before]) {
    if (doc && !(await canEditRecord(userId, doc))) {
      throw new AppError(
        403,
        "You do not have access to the project this record belongs to",
        "FORBIDDEN",
      );
    }
  }

  // Claim first so two clicks cannot restore twice.
  const claimed = await AgentActivityModel.findOneAndUpdate(
    { _id: activity._id, undoneAt: null },
    { $set: { undoneAt: new Date(), undoneBy: userId } },
    { new: true },
  );
  if (!claimed)
    throw new AppError(409, "This action was already undone", "CONFLICT");

  try {
    if (undo.before && current) {
      await collection.replaceOne({ _id }, { ...undo.before, _id });
    } else if (undo.before) {
      // Only an agent's delete brings a record back (checked above).
      await collection.insertOne({ ...undo.before, _id });
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
