import type { ClientSession } from "mongoose";

import EpicModel, {
  IEpicDocument,
  type EpicStatus,
} from "../../../modules/epic/models/epic.model.js";
import NoteModel from "../../note/models/note.model.js";
import TaskModel from "../../task/models/task.model.js";
import { andRefMatches, buildSafeRefMatch } from "../../../utils/mongo-ref.js";
import { runInTransaction } from "../../../utils/transaction.js";

export interface CreateEpicPayload {
  projectId: string;
  name: string;
  description?: string;
  status?: EpicStatus;
  order: number;
}

export interface UpdateEpicPayload {
  name?: string;
  description?: string;
  status?: EpicStatus;
}

export interface ReorderEpicPayload {
  id: string;
  order: number;
}

export const createEpic = async (
  payload: CreateEpicPayload,
): Promise<IEpicDocument> => EpicModel.create(payload);

export const getEpicsByProject = async (
  projectId: string,
): Promise<IEpicDocument[]> =>
  EpicModel.find(buildSafeRefMatch("projectId", projectId))
    .sort({ order: 1, _id: 1 })
    .exec();

/** Epics of several projects at once, each project's epics in their order. */
export const getEpicsByProjects = async (
  projectIds: string[],
): Promise<IEpicDocument[]> =>
  EpicModel.find({ projectId: { $in: projectIds } })
    .sort({ projectId: 1, order: 1, _id: 1 })
    .exec();

export const getEpicById = async (
  epicId: string,
): Promise<IEpicDocument | null> => EpicModel.findById(epicId).exec();

export const getEpicByIdAndProject = async (
  epicId: string,
  projectId: string,
): Promise<IEpicDocument | null> =>
  EpicModel.findOne(
    andRefMatches({ _id: epicId }, buildSafeRefMatch("projectId", projectId)),
  ).exec();

export const updateEpic = async (
  epicId: string,
  projectId: string,
  updates: UpdateEpicPayload,
): Promise<IEpicDocument | null> =>
  EpicModel.findOneAndUpdate(
    andRefMatches({ _id: epicId }, buildSafeRefMatch("projectId", projectId)),
    updates,
    {
      new: true,
    },
  ).exec();

export const getNextEpicOrder = async (projectId: string): Promise<number> => {
  const latestEpic = await EpicModel.findOne(
    buildSafeRefMatch("projectId", projectId),
  )
    .sort({ order: -1, _id: -1 })
    .select({ order: 1 })
    .lean()
    .exec();

  return latestEpic == null ? 0 : latestEpic.order + 1;
};

const withSession = <T>(
  callback: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> => runInTransaction(callback);

export const deleteEpic = async (
  epicId: string,
  projectId: string,
): Promise<IEpicDocument | null> =>
  withSession(async (session) => {
    await TaskModel.updateMany(
      andRefMatches(
        buildSafeRefMatch("projectId", projectId),
        buildSafeRefMatch("epicId", epicId),
      ),
      { $set: { epicId: null } },
      { session: session as any },
    ).exec();
    await NoteModel.deleteMany(buildSafeRefMatch("epicId", epicId), {
      session: session as any,
    }).exec();

    const deletedEpic = await EpicModel.findOneAndDelete(
      andRefMatches({ _id: epicId }, buildSafeRefMatch("projectId", projectId)),
      { session: session as any },
    ).exec();

    if (deletedEpic == null) {
      return null;
    }

    const remainingEpics = await EpicModel.find(
      buildSafeRefMatch("projectId", projectId),
    )
      .sort({ order: 1, _id: 1 })
      .session(session as any)
      .exec();

    for (const [index, epic] of remainingEpics.entries()) {
      if (epic.order !== index) {
        epic.order = index;
        await epic.save({ session: session as any });
      }
    }

    return deletedEpic;
  });

export const reorderEpics = async (
  projectId: string,
  payload: ReorderEpicPayload[],
): Promise<IEpicDocument[]> =>
  withSession(async (session) => {
    const orderOffset = payload.length + 1;

    for (const item of payload) {
      await EpicModel.updateOne(
        andRefMatches(
          { _id: item.id },
          buildSafeRefMatch("projectId", projectId),
        ),
        { $set: { order: item.order + orderOffset } },
        { session: session as any },
      ).exec();
    }

    for (const item of payload) {
      await EpicModel.updateOne(
        andRefMatches(
          { _id: item.id },
          buildSafeRefMatch("projectId", projectId),
        ),
        { $set: { order: item.order } },
        { session: session as any },
      ).exec();
    }

    return EpicModel.find(buildSafeRefMatch("projectId", projectId))
      .sort({ order: 1, _id: 1 })
      .session(session as any)
      .exec();
  });

export const deleteEpicsByProject = async (
  projectId: string,
): Promise<void> => {
  await EpicModel.deleteMany(buildSafeRefMatch("projectId", projectId)).exec();
};
