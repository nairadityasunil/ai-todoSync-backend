import mongoose, { type ClientSession } from "mongoose";

import ProjectModel, { IProjectDocument } from "../models/project.model.js";
import TaskModel from "../../task/models/task.model.js";
import EpicModel from "../../epic/models/epic.model.js";
import NoteModel from "../../note/models/note.model.js";
import ProjectMemberModel from "../models/project-member.model.js";
import TimeEntryModel from "../../time-tracking/time-entry.model.js";
import PromptLibraryModel from "../../prompt/models/prompt-library.model.js";
import {
  andRefMatches,
  buildSafeRefInMatch,
  buildSafeRefMatch,
} from "../../../utils/mongo-ref.js";
import { runInTransaction } from "../../../utils/transaction.js";
import { escapeRegex } from "../../../shared/environment.js";

export const projectPopulateOptions = [
  { path: "userId", select: "email name firstName lastName" },
];

export interface CreateProjectPayload {
  userId: string;
  workspaceId: string;
  name: string;
  description?: string;
  uuid?: string;
}

export interface UpdateProjectPayload {
  name?: string;
  description?: string;
}

export const createProject = async (
  payload: CreateProjectPayload,
  session?: ClientSession | null,
): Promise<IProjectDocument> =>
  ProjectModel.create([{ ...payload }], { session }).then(
    ([project]) => project,
  );

export interface ProjectListParams {
  /** Projects the caller may see (from accessService.accessibleProjectIds). */
  projectIds: string[];
  search?: string;
  skip?: number;
  limit?: number;
}

const projectListQuery = ({ projectIds, search }: ProjectListParams) => {
  const validObjectIds = projectIds.filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );
  const uuidList = projectIds.filter(
    (id) => !mongoose.Types.ObjectId.isValid(id),
  );

  const idQuery =
    uuidList.length > 0
      ? {
          $or: [
            { _id: { $in: validObjectIds } },
            { uuid: { $in: projectIds } },
          ],
        }
      : buildSafeRefInMatch("_id", projectIds);

  const query: Record<string, unknown> = { ...idQuery };
  if (search?.trim()) {
    query.name = { $regex: escapeRegex(search.trim()), $options: "i" };
  }
  return query;
};

export const getProjectsByIds = async (
  params: ProjectListParams,
): Promise<IProjectDocument[]> => {
  if (params.projectIds.length === 0) return [];
  let query = ProjectModel.find(projectListQuery(params))
    .populate(projectPopulateOptions)
    .sort({ name: 1, _id: 1 });
  if (params.skip) query = query.skip(params.skip);
  if (params.limit) query = query.limit(params.limit);
  return query.exec();
};

export const countProjectsByIds = async (
  params: ProjectListParams,
): Promise<number> =>
  params.projectIds.length === 0
    ? 0
    : ProjectModel.countDocuments(projectListQuery(params)).exec();

export const getProjectById = async (
  projectId: string,
): Promise<IProjectDocument | null> => {
  const query = mongoose.Types.ObjectId.isValid(projectId)
    ? { $or: [{ _id: projectId }, { uuid: projectId }] }
    : { uuid: projectId };
  return ProjectModel.findOne(query).populate(projectPopulateOptions).exec();
};

export const getProjectByIdAndUser = async (
  projectId: string,
  userId: string,
): Promise<IProjectDocument | null> => {
  const project = await getProjectById(projectId);
  if (!project) return null;

  const membership = await ProjectMemberModel.exists({
    ...andRefMatches(
      buildSafeRefMatch("projectId", project._id.toString()),
      buildSafeRefMatch("userId", userId),
    ),
  });

  return membership ? project : null;
};

export const getProjectByName = async (
  userId: string,
  name: string,
): Promise<IProjectDocument | null> =>
  ProjectModel.findOne(
    andRefMatches({ name }, buildSafeRefMatch("userId", userId)),
  ).exec();

export const updateProject = async (
  projectId: string,
  updates: UpdateProjectPayload,
): Promise<IProjectDocument | null> => {
  const query = mongoose.Types.ObjectId.isValid(projectId)
    ? { $or: [{ _id: projectId }, { uuid: projectId }] }
    : { uuid: projectId };
  return ProjectModel.findOneAndUpdate(query, updates, {
    new: true,
  }).exec();
};

export const deleteProject = async (
  projectId: string,
): Promise<IProjectDocument | null> => {
  const query = mongoose.Types.ObjectId.isValid(projectId)
    ? { $or: [{ _id: projectId }, { uuid: projectId }] }
    : { uuid: projectId };
  return ProjectModel.findOneAndDelete(query).exec();
};

export const deleteTasksByProject = async (
  userId: string,
  projectId: string,
): Promise<void> => {
  await TaskModel.deleteMany(
    andRefMatches(
      buildSafeRefMatch("userId", userId),
      buildSafeRefMatch("projectId", projectId),
    ),
  ).exec();
};

/**
 * Removes everything that belongs to the given projects. Prompts outlive
 * their project: they are unlinked, not deleted.
 */
const deleteRelations = async (
  projectIds: string[],
  session: ClientSession | null,
): Promise<void> => {
  const opts = { session: session as any };
  const byProject = buildSafeRefInMatch("projectId", projectIds);
  await Promise.all([
    TaskModel.deleteMany(byProject, opts).exec(),
    EpicModel.deleteMany(byProject, opts).exec(),
    NoteModel.deleteMany(byProject, opts).exec(),
    ProjectMemberModel.deleteMany(byProject, opts).exec(),
    TimeEntryModel.deleteMany(byProject, opts).exec(),
    PromptLibraryModel.updateMany(
      byProject,
      { $set: { projectId: null } },
      opts,
    ).exec(),
  ]);
};

export const deleteProjectWithRelations = async (
  projectId: string,
): Promise<IProjectDocument | null> =>
  runInTransaction(async (session) => {
    const query = mongoose.Types.ObjectId.isValid(projectId)
      ? { $or: [{ _id: projectId }, { uuid: projectId }] }
      : { uuid: projectId };
    const deletedProject = await ProjectModel.findOneAndDelete(query, {
      session: session as any,
    }).exec();
    if (deletedProject == null) return null;
    await deleteRelations([deletedProject._id.toString()], session ?? null);
    return deletedProject;
  });

export const deleteProjectsWithRelations = async (
  projectIds: string[],
): Promise<number> =>
  runInTransaction(async (session) => {
    const validObjectIds = projectIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );
    const query = {
      $or: [{ _id: { $in: validObjectIds } }, { uuid: { $in: projectIds } }],
    };
    const projects = await ProjectModel.find(
      query,
      { _id: 1 },
      { session: session as any },
    ).exec();
    const ids = projects.map((p) => p._id.toString());
    const { deletedCount } = await ProjectModel.deleteMany(
      { _id: { $in: ids } },
      { session: session as any },
    ).exec();
    if (deletedCount > 0) await deleteRelations(ids, session ?? null);
    return deletedCount;
  });
