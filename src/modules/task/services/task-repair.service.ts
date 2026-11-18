import logger from "../../../lib/logger.js";
import TaskModel from "../models/task.model.js";

/**
 * The old nightly rollover copied unfinished tasks to the next day and marked the originals "rolled_over".
 * The copy step silently dropped tasks that failed validation, but the originals were marked all the same, so
 * those tasks vanished from every list. Tasks are no longer rolled over; this brings back every marked task
 * that has no live copy (as "TODO", in the same epic, state and project). Originals whose copy exists stay
 * hidden so nothing shows twice. Safe to run again and again.
 */
export const restoreRolledOverTasks = async (): Promise<number> => {
  let restored = 0;
  const marked = await TaskModel.find({ status: "rolled_over" })
    .select("_id userId projectId title date rolloverCount")
    .lean()
    .exec();
  for (const task of marked) {
    const copy = await TaskModel.exists({
      _id: { $ne: task._id },
      userId: task.userId,
      projectId: task.projectId ?? null,
      title: task.title,
      rolloverCount: (task.rolloverCount ?? 0) + 1,
      status: { $ne: "rolled_over" },
    });
    if (copy) continue;
    await TaskModel.updateOne(
      { _id: task._id, status: "rolled_over" },
      { $set: { status: "TODO", rolledOver: false } },
    ).exec();
    restored += 1;
  }
  if (marked.length > 0) {
    logger.info(
      `Rolled-over tasks checked: ${restored} brought back, ${marked.length - restored} hidden because their copy exists`,
    );
  }
  return restored;
};
