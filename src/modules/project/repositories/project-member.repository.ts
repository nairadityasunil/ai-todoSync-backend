import type { ClientSession } from "mongoose";

import ProjectMemberModel, {
  type IProjectMemberDocument,
  type ProjectRole,
} from "../../../modules/project/models/project-member.model.js";
import { andRefMatches, buildSafeRefMatch } from "../../../utils/mongo-ref.js";
import { ensureWorkspaceMembersForProject } from "../../workspace/repositories/workspace-member.repository.js";
interface ProjectMemberUserShape {
  _id: { toString(): string };
  email: string;
  name: string | null;
}

export interface CreateProjectMemberPayload {
  projectId: string;
  userId: string;
  role: ProjectRole;
}

export interface ProjectMemberWithUser {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  permissions?: IProjectMemberDocument["permissions"];
  createdAt?: Date;
  user: ProjectMemberUserShape;
}

const memberUserProjection = "email name";

export const createProjectMember = async (
  payload: CreateProjectMemberPayload,
  session?: ClientSession | null,
): Promise<IProjectMemberDocument> => {
  const [member] = await ProjectMemberModel.create([{ ...payload }], {
    session,
  });
  // A project member is also a member of the project's workspace.
  await ensureWorkspaceMembersForProject(
    payload.projectId,
    [payload.userId],
    session,
  );
  return member;
};

export const createProjectMembers = async (
  payloads: CreateProjectMemberPayload[],
  session?: ClientSession | null,
): Promise<IProjectMemberDocument[]> => {
  if (payloads.length === 0) {
    return [];
  }

  const members = await ProjectMemberModel.insertMany(payloads, {
    session,
    ordered: true,
  });
  const byProject = new Map<string, string[]>();
  for (const p of payloads)
    byProject.set(p.projectId, [
      ...(byProject.get(p.projectId) ?? []),
      p.userId,
    ]);
  for (const [projectId, userIds] of byProject)
    await ensureWorkspaceMembersForProject(projectId, userIds, session);
  return members;
};

export const getProjectMembership = async (
  projectId: string,
  userId: string,
): Promise<IProjectMemberDocument | null> =>
  ProjectMemberModel.findOne(
    andRefMatches(
      buildSafeRefMatch("projectId", projectId),
      buildSafeRefMatch("userId", userId),
    ),
  ).exec();

export const getProjectMembershipsByUser = async (
  userId: string,
): Promise<IProjectMemberDocument[]> =>
  ProjectMemberModel.find(buildSafeRefMatch("userId", userId))
    .sort({ createdAt: 1, _id: 1 })
    .exec();

export const getProjectMembers = async (
  projectId: string,
): Promise<ProjectMemberWithUser[]> => {
  const members = await ProjectMemberModel.find(
    buildSafeRefMatch("projectId", projectId),
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
      permissions: member.permissions,
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

export const countProjectAdmins = async (projectId: string): Promise<number> =>
  ProjectMemberModel.countDocuments({
    role: "ADMIN",
    ...buildSafeRefMatch("projectId", projectId),
  }).exec();

export const deleteProjectMembership = async (
  projectId: string,
  userId: string,
  session?: ClientSession | null,
): Promise<IProjectMemberDocument | null> =>
  ProjectMemberModel.findOneAndDelete(
    andRefMatches(
      buildSafeRefMatch("projectId", projectId),
      buildSafeRefMatch("userId", userId),
    ),
    { session: session as any },
  ).exec();

export const deleteProjectMembershipsByProject = async (
  projectId: string,
  session?: ClientSession | null,
): Promise<void> => {
  await ProjectMemberModel.deleteMany(
    buildSafeRefMatch("projectId", projectId),
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
  await ProjectMemberModel.updateOne(
    andRefMatches(
      buildSafeRefMatch("projectId", projectId),
      buildSafeRefMatch("userId", userId),
    ),
    { $setOnInsert: { role: "ADMIN" } },
    { upsert: true, session: session as any },
  ).exec();
};

export const setMemberPermissions = async (
  projectId: string,
  userId: string,
  patch: Record<string, boolean>,
): Promise<IProjectMemberDocument | null> => {
  const set: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(patch))
    set[`permissions.${key}`] = value;
  return ProjectMemberModel.findOneAndUpdate(
    andRefMatches(
      buildSafeRefMatch("projectId", projectId),
      buildSafeRefMatch("userId", userId),
    ),
    { $set: set },
    { new: true },
  ).exec();
};
