import type { ClientSession } from "mongoose";

import ProjectMemberModel, {
  type IProjectMemberDocument,
  type ProjectRole,
} from "../../../modules/project/models/project-member.model.js";
import { andRefMatches, buildSafeRefMatch } from "../../../utils/mongo-ref.js";
import { resolveProjectObjectId } from "../../../utils/project-id.js";

interface ProjectMemberUserShape {
  _id: { toString(): string };
  email: string;
  name: string | null;
}

export interface CreateProjectMemberPayload {
  projectId: string;
  userId: string;
  role: ProjectRole;
  grantedBy?: string | null;
}

export interface ProjectMemberWithUser {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt?: Date;
  user: ProjectMemberUserShape;
}

const memberUserProjection = "email name";

export const createProjectMember = async (
  payload: CreateProjectMemberPayload,
  session?: ClientSession | null,
): Promise<IProjectMemberDocument> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(payload.projectId)) || payload.projectId;
  return ProjectMemberModel.create(
    [{ ...payload, projectId: resolvedProjectId }],
    { session },
  ).then(([member]) => member);
};

export const createProjectMembers = async (
  payloads: CreateProjectMemberPayload[],
  session?: ClientSession | null,
): Promise<IProjectMemberDocument[]> => {
  if (payloads.length === 0) {
    return [];
  }

  const resolved = await Promise.all(
    payloads.map(async (p) => ({
      ...p,
      projectId: (await resolveProjectObjectId(p.projectId)) || p.projectId,
    })),
  );

  return ProjectMemberModel.insertMany(resolved, { session, ordered: true });
};

export const getProjectMembership = async (
  projectId: string,
  userId: string,
): Promise<IProjectMemberDocument | null> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return ProjectMemberModel.findOne(
    andRefMatches(
      buildSafeRefMatch("projectId", resolvedProjectId),
      buildSafeRefMatch("userId", userId),
    ),
  ).exec();
};

export const getProjectMembershipsByUser = async (
  userId: string,
): Promise<IProjectMemberDocument[]> =>
  ProjectMemberModel.find(buildSafeRefMatch("userId", userId))
    .sort({ createdAt: 1, _id: 1 })
    .exec();

export const getProjectMembers = async (
  projectId: string,
): Promise<ProjectMemberWithUser[]> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  const members = await ProjectMemberModel.find(
    buildSafeRefMatch("projectId", resolvedProjectId),
  )
    .populate("userId", memberUserProjection)
    .sort({ role: 1, createdAt: 1, _id: 1 })
    .exec();

  const mappedMembers: ProjectMemberWithUser[] = [];

  for (const member of members) {
    const user =
      member.userId as unknown as Partial<ProjectMemberUserShape> | null;

    if (user == null || typeof user.email !== "string" || user._id == null) {
      continue;
    }

    mappedMembers.push({
      id: member._id.toString(),
      projectId: member.projectId.toString(),
      userId: user._id.toString(),
      role: member.role,
      createdAt: member.createdAt,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name ?? null,
      },
    });
  }

  return mappedMembers;
};

export const countProjectAdmins = async (
  projectId: string,
): Promise<number> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return ProjectMemberModel.countDocuments({
    role: "ADMIN",
    ...buildSafeRefMatch("projectId", resolvedProjectId),
  }).exec();
};

export const deleteProjectMembership = async (
  projectId: string,
  userId: string,
  session?: ClientSession | null,
): Promise<IProjectMemberDocument | null> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return ProjectMemberModel.findOneAndDelete(
    andRefMatches(
      buildSafeRefMatch("projectId", resolvedProjectId),
      buildSafeRefMatch("userId", userId),
    ),
    { session: session as any },
  ).exec();
};

export const deleteProjectMembershipsByProject = async (
  projectId: string,
  session?: ClientSession | null,
): Promise<void> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  await ProjectMemberModel.deleteMany(
    buildSafeRefMatch("projectId", resolvedProjectId),
    {
      session: session as any,
    },
  ).exec();
};

export const ensureProjectAdminMembership = async (
  projectId: string,
  userId: string,
  session?: ClientSession | null,
): Promise<void> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  await ProjectMemberModel.updateOne(
    andRefMatches(
      buildSafeRefMatch("projectId", resolvedProjectId),
      buildSafeRefMatch("userId", userId),
    ),
    { $setOnInsert: { role: "ADMIN" } },
    { upsert: true, session: session as any },
  ).exec();
};
