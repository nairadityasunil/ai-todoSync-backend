import type { ClientSession } from "mongoose";

import ProjectModel, { IProjectDocument } from "../models/project.model.js";
import TaskModel from "../../task/models/task.model.js";
import EpicModel from "../../epic/models/epic.model.js";
import NoteModel from "../../note/models/note.model.js";
import ProjectMemberModel from "../models/project-member.model.js";
import { deleteProjectMembershipsByProject } from "./project-member.repository.js";
import {
  andRefMatches,
  buildSafeRefInMatch,
  buildSafeRefMatch,
} from "../../../utils/mongo-ref.js";
import { runInTransaction } from "../../../utils/transaction.js";
import { escapeRegex } from "../../../utils/escape-regex.js";

export const projectPopulateOptions = [
  { path: "userId", select: "email name firstName lastName" },
];

export interface CreateProjectPayload {
  userId: string;
  name: string;
  description?: string;
  workspaceId?: string;
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

export interface ProjectQueryParams {
  userId: string;
  search?: string;
  skip?: number;
  limit?: number;
}

export const getProjectsByUser = async (
  params: ProjectQueryParams,
): Promise<IProjectDocument[]> => {
  const memberships = await ProjectMemberModel.find(
    buildSafeRefMatch("userId", params.userId),
  )
    .select({ projectId: 1 })
    .lean()
    .exec();
  const projectIds = memberships.map((membership) =>
    membership.projectId.toString(),
  );

  if (projectIds.length === 0) {
    return [];
  }

  const query: Record<string, unknown> = buildSafeRefInMatch("_id", projectIds);

  if (params.search) {
    query.name = { $regex: escapeRegex(params.search), $options: "i" };
  }

  return ProjectModel.find(query)
    .populate(projectPopulateOptions)
    .sort({ name: 1, _id: 1 })
    .skip(params.skip || 0)
    .limit(params.limit || 0)
    .exec();
};

const projectIdQuery = (
  projectIds: string[],
  search?: string,
): Record<string, unknown> => {
  const query: Record<string, unknown> = buildSafeRefInMatch("_id", projectIds);
  if (search) {
    query.name = { $regex: escapeRegex(search), $options: "i" };
  }
  return query;
};

/** One page of the given projects plus the total, fetched in parallel. */
export const getProjectsPageByIds = async (params: {
  projectIds: string[];
  search?: string;
  skip?: number;
  limit?: number;
}): Promise<{ projects: IProjectDocument[]; total: number }> => {
  if (params.projectIds.length === 0) {
    return { projects: [], total: 0 };
  }
  const query = projectIdQuery(params.projectIds, params.search);
  const [projects, total] = await Promise.all([
    ProjectModel.find(query)
      .populate(projectPopulateOptions)
      .sort({ name: 1, _id: 1 })
      .skip(params.skip || 0)
      .limit(params.limit || 0)
      .exec(),
    ProjectModel.countDocuments(query).exec(),
  ]);
  return { projects, total };
};

export const countProjectsByUser = async (
  userId: string,
  search?: string,
): Promise<number> => {
  const memberships = await ProjectMemberModel.find(
    buildSafeRefMatch("userId", userId),
  )
    .select({ projectId: 1 })
    .lean()
    .exec();
  const projectIds = memberships.map((membership) =>
    membership.projectId.toString(),
  );

  if (projectIds.length === 0) {
    return 0;
  }

  const query: Record<string, unknown> = buildSafeRefInMatch("_id", projectIds);

  if (search) {
    query.name = { $regex: escapeRegex(search), $options: "i" };
  }

  return ProjectModel.countDocuments(query).exec();
};

export const getProjectById = async (
  projectId: string,
): Promise<IProjectDocument | null> =>
  ProjectModel.findById(projectId).populate(projectPopulateOptions).exec();

/** The project without its creator populated; enough for access checks. */
export const getProjectByIdUnpopulated = async (
  projectId: string,
): Promise<IProjectDocument | null> => ProjectModel.findById(projectId).exec();

export const getProjectByIdAndUser = async (
  projectId: string,
  userId: string,
): Promise<IProjectDocument | null> =>
  ProjectMemberModel.exists({
    ...andRefMatches(
      buildSafeRefMatch("projectId", projectId),
      buildSafeRefMatch("userId", userId),
    ),
  }).then((membership) => {
    if (membership == null) {
      return null;
    }

    return ProjectModel.findById(projectId)
      .populate(projectPopulateOptions)
      .exec();
  });

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
): Promise<IProjectDocument | null> =>
  ProjectModel.findByIdAndUpdate(projectId, updates, {
    new: true,
  }).exec();

export const deleteProject = async (
  projectId: string,
): Promise<IProjectDocument | null> =>
  ProjectModel.findByIdAndDelete(projectId).exec();

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

export const deleteProjectWithRelations = async (
  projectId: string,
): Promise<IProjectDocument | null> => {
  return runInTransaction(async (session) => {
    const deletedProject = await ProjectModel.findByIdAndDelete(projectId, {
      session: session as any,
    }).exec();

    if (deletedProject == null) {
      return null;
    }

    await TaskModel.deleteMany(buildSafeRefMatch("projectId", projectId), {
      session: session as any,
    }).exec();
    await EpicModel.deleteMany(buildSafeRefMatch("projectId", projectId), {
      session: session as any,
    }).exec();
    await NoteModel.deleteMany(buildSafeRefMatch("projectId", projectId), {
      session: session as any,
    }).exec();
    await deleteProjectMembershipsByProject(projectId, session as any);

    return deletedProject;
  });
};

export const deleteProjectsWithRelations = async (
  projectIds: string[],
): Promise<number> => {
  return runInTransaction(async (session) => {
    const result = await ProjectModel.deleteMany(
      { _id: { $in: projectIds } },
      { session: session as any },
    ).exec();

    const deletedCount = result.deletedCount;

    if (deletedCount === 0) {
      return 0;
    }

    await TaskModel.deleteMany(buildSafeRefInMatch("projectId", projectIds), {
      session: session as any,
    }).exec();
    await EpicModel.deleteMany(buildSafeRefInMatch("projectId", projectIds), {
      session: session as any,
    }).exec();
    await NoteModel.deleteMany(buildSafeRefInMatch("projectId", projectIds), {
      session: session as any,
    }).exec();
    await ProjectMemberModel.deleteMany(
      buildSafeRefInMatch("projectId", projectIds),
      { session: session as any },
    ).exec();

    return deletedCount;
  });
};
