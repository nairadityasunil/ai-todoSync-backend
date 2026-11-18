import WorkspaceMemberModel from "../models/workspace-member.model.js";
import type { WorkspaceRole } from "../models/workspace-member.model.js";
import type { ClientSession, Types } from "mongoose";
import ProjectModel from "../../project/models/project.model.js";

export async function findMembership(workspaceId: string, userId: string) {
  return WorkspaceMemberModel.findOne({ workspaceId, userId }).lean();
}

export async function createMembership(data: {
  workspaceId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  role: WorkspaceRole;
}) {
  return WorkspaceMemberModel.create(data);
}

export async function deleteMembership(workspaceId: string, userId: string) {
  return WorkspaceMemberModel.findOneAndDelete({ workspaceId, userId });
}

export async function updateMembershipRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
) {
  return WorkspaceMemberModel.findOneAndUpdate(
    { workspaceId, userId },
    { role },
    { new: true },
  ).lean();
}

export async function listMembersByWorkspace(workspaceId: string) {
  return WorkspaceMemberModel.find({ workspaceId })
    .populate<{
      userId: { _id: any; name?: string | null; email: string };
    }>("userId", "name email")
    .sort({ joinedAt: 1 })
    .lean();
}

export async function countMembersByWorkspace(workspaceId: string) {
  return WorkspaceMemberModel.countDocuments({ workspaceId });
}

export async function findMembershipsByUser(userId: string) {
  return WorkspaceMemberModel.find({ userId }).lean();
}

export async function countOwnersByWorkspace(workspaceId: string) {
  return WorkspaceMemberModel.countDocuments({ workspaceId, role: "OWNER" });
}

/**
 * Being in a project means being in the workspace it belongs to. Adds each person to the project's workspace as a
 * MEMBER when they are not in it yet; anyone already in it (with any role) is left as they are.
 */
export async function ensureWorkspaceMembersForProject(
  projectId: string,
  userIds: Array<string | Types.ObjectId>,
  session?: ClientSession | null,
): Promise<void> {
  if (userIds.length === 0) return;
  const project = await ProjectModel.findById(projectId)
    .select("workspaceId")
    .session(session ?? null)
    .lean();
  if (!project?.workspaceId) return;
  for (const userId of new Set(userIds.map(String))) {
    await WorkspaceMemberModel.updateOne(
      { workspaceId: project.workspaceId, userId },
      { $setOnInsert: { role: "MEMBER", joinedAt: new Date() } },
      { upsert: true, session: session ?? undefined },
    );
  }
}
