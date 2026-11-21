import { NEW_WORKSPACE_GOVERNANCE } from "../../agents/hybrid.js";
import { Types } from "mongoose";
import WorkspaceModel, {
  IWorkspaceDocument,
} from "../../../modules/workspace/models/workspace.model.js";
import WorkspaceMemberModel, {
  WorkspaceRole,
  IWorkspacePermissions,
} from "../../../modules/workspace/models/workspace-member.model.js";
import WorkspaceInvitationModel from "../models/workspace-invitation.model.js";
import emailService from "../../../shared/services/email.service.js";
import crypto from "node:crypto";
import UserModel from "../../auth/models/user.model.js";
import ProjectModel from "../../project/models/project.model.js";
import ProjectMemberModel from "../../project/models/project-member.model.js";
import { deleteProjectMembership } from "../../project/repositories/project-member.repository.js";
import { clearTaskAssignmentsForUser } from "../../task/repositories/task.repository.js";
import { runInTransaction } from "../../../utils/transaction.js";
import {
  buildSafeRefInMatch,
  buildSafeRefMatch,
} from "../../../utils/mongo-ref.js";
import { AppError } from "../../../utils/app-error.js";
import { countOwnersByWorkspace } from "../repositories/workspace-member.repository.js";

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/^-+$/, "workspace");
}

class WorkspaceService {
  public async assertMembership(
    userId: string,
    workspaceId: string,
    allowedRoles?: WorkspaceRole[],
  ) {
    const member = await WorkspaceMemberModel.findOne({
      workspaceId,
      userId,
    }).lean();

    if (!member) {
      throw new AppError(403, "Access denied to workspace", "FORBIDDEN");
    }

    if (allowedRoles && !allowedRoles.includes(member.role)) {
      throw new AppError(
        403,
        `Role '${member.role}' does not have sufficient permission`,
        "FORBIDDEN",
      );
    }

    const workspace = await WorkspaceModel.findById(workspaceId).lean();
    if (!workspace) {
      throw new AppError(404, "Workspace not found", "NOT_FOUND");
    }

    return { workspace, member };
  }

  public async getOrCreateDefaultWorkspace(userId: string) {
    const existingMember = await WorkspaceMemberModel.findOne({ userId })
      .sort({ createdAt: 1 })
      .lean();

    if (existingMember) {
      const workspace = await WorkspaceModel.findById(
        existingMember.workspaceId,
      ).lean();
      if (workspace) return workspace;
    }

    const user = await UserModel.findById(userId).lean();
    const name = user?.name ? `${user.name}'s Workspace` : "Personal Workspace";
    let baseSlug = slugify(name) || `workspace-${userId.slice(-4)}`;
    let slug = baseSlug;
    let count = 1;
    while (await WorkspaceModel.findOne({ slug }).lean()) {
      slug = `${baseSlug}-${count++}`;
    }

    const workspace = await WorkspaceModel.create({
      name,
      slug,
      ownerId: userId,
      settings: { governance: { ...NEW_WORKSPACE_GOVERNANCE } },
    });

    await WorkspaceMemberModel.create({
      workspaceId: workspace._id,
      userId,
      role: "OWNER",
      lastUsedAt: new Date(),
    });

    return workspace.toObject();
  }

  public async createWorkspace(
    userId: string,
    payload: { name: string; slug?: string },
  ) {
    if (!payload.name?.trim()) {
      throw new AppError(400, "Workspace name is required", "BAD_REQUEST");
    }

    let baseSlug = slugify(payload.slug || payload.name);
    let slug = baseSlug;
    let count = 1;
    while (await WorkspaceModel.findOne({ slug }).lean()) {
      slug = `${baseSlug}-${count++}`;
    }

    const workspace = await WorkspaceModel.create({
      name: payload.name.trim(),
      slug,
      ownerId: userId,
      settings: { governance: { ...NEW_WORKSPACE_GOVERNANCE } },
    });

    await WorkspaceMemberModel.create({
      workspaceId: workspace._id,
      userId,
      role: "OWNER",
      lastUsedAt: new Date(),
    });

    return workspace.toObject();
  }

  public async listUserWorkspaces(userId: string) {
    const memberships = await WorkspaceMemberModel.find({ userId }).lean();
    const workspaceIds = memberships.map((m) => m.workspaceId);

    if (workspaceIds.length === 0) {
      // Auto-initialize default workspace if none
      const defaultWs = await this.getOrCreateDefaultWorkspace(userId);
      workspaceIds.push(defaultWs._id);
    }

    // Workspaces and their member/project counts load together: two grouped
    // counts instead of two queries per workspace.
    const countBy = (
      model: typeof WorkspaceMemberModel | typeof ProjectModel,
    ): Promise<Array<{ _id: unknown; count: number }>> =>
      (model as typeof WorkspaceMemberModel)
        .aggregate<{ _id: unknown; count: number }>([
          // Aggregations skip Mongoose casting, so pass real ObjectIds.
          {
            $match: {
              workspaceId: {
                $in: workspaceIds.map((id) => new Types.ObjectId(String(id))),
              },
            },
          },
          { $group: { _id: "$workspaceId", count: { $sum: 1 } } },
        ])
        .exec();
    const [workspaces, memberCounts, projectCounts] = await Promise.all([
      WorkspaceModel.find({ _id: { $in: workspaceIds } })
        .sort({ createdAt: 1 })
        .lean(),
      countBy(WorkspaceMemberModel),
      countBy(ProjectModel),
    ]);
    const toMap = (rows: Array<{ _id: unknown; count: number }>) =>
      new Map(rows.map((row) => [String(row._id), row.count]));
    const membersByWorkspace = toMap(memberCounts);
    const projectsByWorkspace = toMap(projectCounts);
    const roleByWorkspace = new Map(
      memberships.map((m) => [m.workspaceId.toString(), m.role]),
    );
    const usedByWorkspace = new Map(
      memberships.map((m) => [m.workspaceId.toString(), m.lastUsedAt ?? null]),
    );

    const rows = workspaces.map((ws) => {
      const id = ws._id.toString();
      return {
        id,
        name: ws.name,
        slug: ws.slug,
        ownerId: ws.ownerId.toString(),
        role: roleByWorkspace.get(id) || "MEMBER",
        memberCount: membersByWorkspace.get(id) ?? 0,
        projectCount: projectsByWorkspace.get(id) ?? 0,
        createdAt: ws.createdAt,
        lastUsedAt: usedByWorkspace.get(id) ?? null,
      };
    });
    // The ones this person opened most recently first; never-opened ones keep the order they were created in.
    return rows.sort((a, b) => {
      const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : -1;
      const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : -1;
      if (at !== bt) return bt - at;
      return (
        new Date(a.createdAt as Date).getTime() -
        new Date(b.createdAt as Date).getTime()
      );
    });
  }

  /** Records that this person just opened the workspace (for the "recent" list in the switcher). */
  public async markUsed(userId: string, workspaceId: string): Promise<void> {
    await this.assertMembership(userId, workspaceId);
    await WorkspaceMemberModel.updateOne(
      { workspaceId, userId },
      { $set: { lastUsedAt: new Date() } },
    );
  }

  public async getWorkspaceDetails(userId: string, workspaceId: string) {
    const { workspace, member } = await this.assertMembership(
      userId,
      workspaceId,
    );

    const members = await WorkspaceMemberModel.find({ workspaceId })
      .populate<{
        userId: { _id: any; name?: string; email: string };
      }>("userId", "name email")
      .lean();

    const projects = await ProjectModel.find({
      workspaceId,
      isArchived: { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .lean();

    return {
      id: workspace._id.toString(),
      name: workspace.name,
      slug: workspace.slug,
      ownerId: workspace.ownerId.toString(),
      currentUserRole: member.role,
      settings: workspace.settings,
      createdAt: workspace.createdAt,
      members: members.map((m) => ({
        id: m._id.toString(),
        userId: m.userId?._id?.toString() ?? "",
        name: m.userId?.name || "Unknown",
        email: m.userId?.email || "",
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      projects: projects.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        description: p.description,
        icon: p.icon || "folder",
        color: p.color || "#3B82F6",
        status: p.status || "ACTIVE",
        priority: p.priority || "MEDIUM",
        startDate: p.startDate,
        targetDate: p.targetDate,
      })),
    };
  }

  public async updateWorkspace(
    userId: string,
    workspaceId: string,
    payload: { name?: string; slug?: string; settings?: any },
  ) {
    await this.assertMembership(userId, workspaceId, ["OWNER", "ADMIN"]);

    const updates: Partial<IWorkspaceDocument> = {};
    if (payload.name?.trim()) {
      updates.name = payload.name.trim();
    }
    if (payload.slug?.trim()) {
      const candidateSlug = payload.slug.trim();
      const existing = await WorkspaceModel.findOne({
        slug: candidateSlug,
      }).lean();
      if (existing && existing._id.toString() !== workspaceId) {
        throw new AppError(409, "Workspace slug is already taken", "CONFLICT");
      }
      updates.slug = candidateSlug;
    }
    if (payload.settings) {
      updates.settings = payload.settings;
    }

    const updated = await WorkspaceModel.findByIdAndUpdate(
      workspaceId,
      updates,
      {
        new: true,
      },
    ).lean();

    if (!updated) {
      throw new AppError(404, "Workspace not found", "NOT_FOUND");
    }

    return updated;
  }

  public getDefaultPermissions(role: WorkspaceRole): IWorkspacePermissions {
    if (role === "OWNER" || role === "ADMIN") {
      return {
        projects: true,
        members: true,
        settings: true,
        agentGovernance: true,
        prompts: true,
        timeTracking: true,
      };
    }
    if (role === "MANAGER") {
      return {
        projects: true,
        members: false,
        settings: false,
        agentGovernance: false,
        prompts: true,
        timeTracking: true,
      };
    }
    if (role === "MEMBER") {
      return {
        projects: true,
        members: false,
        settings: false,
        agentGovernance: false,
        prompts: false,
        timeTracking: true,
      };
    }
    // GUEST
    return {
      projects: false,
      members: false,
      settings: false,
      agentGovernance: false,
      prompts: false,
      timeTracking: false,
    };
  }

  public async inviteMember(
    userId: string,
    workspaceId: string,
    payload: { email: string; role?: WorkspaceRole },
  ) {
    await this.assertMembership(userId, workspaceId, ["OWNER", "ADMIN"]);

    if (!payload.email?.trim()) {
      throw new AppError(400, "User email is required", "BAD_REQUEST");
    }

    const email = payload.email.trim().toLowerCase();
    const role = payload.role || "MEMBER";

    const [workspace, inviter] = await Promise.all([
      WorkspaceModel.findById(workspaceId).select("name").lean(),
      UserModel.findById(userId).select("name email").lean(),
    ]);

    const targetUser = await UserModel.findOne({ email }).lean();

    if (targetUser) {
      const existingMember = await WorkspaceMemberModel.findOne({
        workspaceId,
        userId: targetUser._id,
      }).lean();

      if (existingMember) {
        throw new AppError(
          409,
          "User is already a workspace member",
          "CONFLICT",
        );
      }

      const newMember = await WorkspaceMemberModel.create({
        workspaceId,
        userId: targetUser._id,
        role,
        permissions: this.getDefaultPermissions(role),
      });

      // Tell them by email, with the workspace and who added them
      const { enqueueInvitationMail } =
        await import("./invitation-queue.service.js");
      await enqueueInvitationMail("send-workspace-added-email", {
        email: targetUser.email,
        projectName: workspace?.name ?? "a workspace",
        inviterName: inviter?.name || inviter?.email || "A teammate",
      });

      return {
        id: newMember._id.toString(),
        userId: targetUser._id.toString(),
        name: targetUser.name || "Unknown",
        email: targetUser.email,
        role: newMember.role,
        permissions: newMember.permissions,
        joinedAt: newMember.joinedAt,
      };
    } else {
      // Outside user without an account: create pending workspace invitation
      const token = crypto.randomBytes(32).toString("hex");
      await WorkspaceInvitationModel.findOneAndUpdate(
        { workspaceId, email },
        {
          $set: {
            workspaceId,
            email,
            role,
            token,
            status: "PENDING",
            invitedBy: userId,
          },
        },
        { upsert: true, new: true },
      );

      const frontendUrl =
        process.env.FRONTEND_BASE_URL ||
        process.env.FRONTEND_URL ||
        "http://localhost:5173";
      const inviteUrl = `${frontendUrl}/accept-invitation?token=${token}&type=workspace`;
      const inviterName = inviter?.name || inviter?.email || "A teammate";
      const subject = `You're invited to join ${workspace?.name ?? "a workspace"} on Pristine`;
      const text = `${inviterName} has invited you to join the workspace "${workspace?.name ?? "Workspace"}" on Pristine.\nAccept here: ${inviteUrl}`;
      const html = `<p>${inviterName} has invited you to join the workspace <strong>${workspace?.name ?? "Workspace"}</strong> on Pristine.</p><p><a href="${inviteUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Join Workspace</a></p>`;

      void emailService.sendEmail(email, subject, text, html);

      return {
        id: token,
        userId: "",
        name: email.split("@")[0],
        email,
        role,
        permissions: this.getDefaultPermissions(role),
        status: "PENDING",
        message: "Invitation sent to outside user",
      };
    }
  }

  /**
   * Takes a person out of a workspace: out of every project in it too (otherwise being a project member would
   * make them a workspace member again), with their task assignments there cleared. Someone who is the admin of a
   * project in the workspace must hand it over or delete it first, the same rule as leaving a single project.
   */
  private async detachFromWorkspace(
    targetUserId: string,
    workspaceId: string,
  ): Promise<void> {
    const projects = await ProjectModel.find(
      buildSafeRefMatch("workspaceId", workspaceId),
    )
      .select({ _id: 1, name: 1 })
      .lean()
      .exec();
    const projectIds = projects.map((p) => String(p._id));

    if (projectIds.length > 0) {
      const adminOf = await ProjectMemberModel.find({
        ...buildSafeRefInMatch("projectId", projectIds),
        ...buildSafeRefMatch("userId", targetUserId),
        role: "ADMIN",
      })
        .select({ projectId: 1 })
        .lean()
        .exec();
      if (adminOf.length > 0) {
        const names = adminOf
          .map(
            (m) =>
              projects.find((p) => String(p._id) === String(m.projectId))?.name,
          )
          .filter(Boolean)
          .join(", ");
        throw new AppError(
          409,
          `Project admins cannot leave their projects. Delete ${names} first.`,
          "CONFLICT",
        );
      }
    }

    await runInTransaction(async (session) => {
      for (const projectId of projectIds) {
        await deleteProjectMembership(projectId, targetUserId, session);
        await clearTaskAssignmentsForUser(projectId, targetUserId, session);
      }
      await WorkspaceMemberModel.findOneAndDelete(
        { workspaceId, userId: targetUserId },
        { session: session as any },
      );
    });
  }

  public async removeMember(
    userId: string,
    workspaceId: string,
    targetUserId: string,
  ) {
    const { workspace } = await this.assertMembership(userId, workspaceId, [
      "OWNER",
      "ADMIN",
    ]);

    if (workspace.ownerId.toString() === targetUserId) {
      throw new AppError(400, "Cannot remove workspace owner", "BAD_REQUEST");
    }

    await this.detachFromWorkspace(targetUserId, workspaceId);

    return { success: true };
  }

  /** A member leaves a workspace on their own. The owner cannot: they delete the workspace instead. */
  public async leaveWorkspace(userId: string, workspaceId: string) {
    const { workspace, member } = await this.assertMembership(
      userId,
      workspaceId,
    );

    if (member.role === "OWNER" || workspace.ownerId.toString() === userId) {
      throw new AppError(
        400,
        "The owner cannot leave the workspace. Delete it instead.",
        "BAD_REQUEST",
      );
    }

    await this.detachFromWorkspace(userId, workspaceId);

    return { success: true };
  }

  public async listMembers(userId: string, workspaceId: string) {
    await this.assertMembership(userId, workspaceId);
    const members = await WorkspaceMemberModel.find({ workspaceId })
      .populate<{
        userId: { _id: any; name?: string | null; email: string };
      }>("userId", "name email")
      .sort({ joinedAt: 1 })
      .lean();

    return members.map((m) => ({
      id: m._id.toString(),
      userId: m.userId?._id?.toString() ?? "",
      name: m.userId?.name || "Unknown",
      email: m.userId?.email || "",
      role: m.role,
      permissions: m.permissions || this.getDefaultPermissions(m.role),
      joinedAt: m.joinedAt,
    }));
  }

  public async updateMemberPermissions(
    actorUserId: string,
    workspaceId: string,
    targetUserId: string,
    permissions: Partial<IWorkspacePermissions>,
  ) {
    await this.assertMembership(actorUserId, workspaceId, ["OWNER", "ADMIN"]);

    const targetMember = await WorkspaceMemberModel.findOne({
      workspaceId,
      userId: targetUserId,
    });

    if (!targetMember) {
      throw new AppError(404, "Member not found", "NOT_FOUND");
    }

    if (targetMember.role === "OWNER") {
      throw new AppError(
        400,
        "Cannot alter permissions for the workspace owner",
        "BAD_REQUEST",
      );
    }

    const currentPerms =
      targetMember.permissions || this.getDefaultPermissions(targetMember.role);
    targetMember.permissions = {
      ...currentPerms,
      ...permissions,
    };

    await targetMember.save();

    return {
      userId: targetUserId,
      role: targetMember.role,
      permissions: targetMember.permissions,
    };
  }

  public async updateMemberRole(
    userId: string,
    workspaceId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ) {
    const { member: actorMember } = await this.assertMembership(
      userId,
      workspaceId,
      ["OWNER", "ADMIN"],
    );

    // Cannot change own role
    if (userId === targetUserId) {
      throw new AppError(400, "Cannot change your own role", "BAD_REQUEST");
    }

    // Only OWNER can grant OWNER role
    if (role === "OWNER" && actorMember.role !== "OWNER") {
      throw new AppError(
        403,
        "Only an OWNER can assign the OWNER role",
        "FORBIDDEN",
      );
    }

    const targetMember = await WorkspaceMemberModel.findOne({
      workspaceId,
      userId: targetUserId,
    }).lean();

    if (!targetMember) {
      throw new AppError(404, "Member not found", "NOT_FOUND");
    }

    // ADMIN cannot change an OWNER's role
    if (targetMember.role === "OWNER" && actorMember.role !== "OWNER") {
      throw new AppError(
        403,
        "Cannot change role of workspace owner",
        "FORBIDDEN",
      );
    }

    // Ensure at least one OWNER remains
    if (targetMember.role === "OWNER" && role !== "OWNER") {
      const ownerCount = await countOwnersByWorkspace(workspaceId);
      if (ownerCount <= 1) {
        throw new AppError(
          400,
          "Workspace must have at least one owner",
          "BAD_REQUEST",
        );
      }
    }

    const updated = await WorkspaceMemberModel.findOneAndUpdate(
      { workspaceId, userId: targetUserId },
      { role },
      { new: true },
    ).lean();

    return updated;
  }

  public async deleteWorkspace(userId: string, workspaceId: string) {
    await this.assertMembership(userId, workspaceId, ["OWNER"]);

    // Delete all members
    await WorkspaceMemberModel.deleteMany({ workspaceId });

    // Soft-disassociate projects (preserve them, just unlink from workspace)
    await ProjectModel.updateMany(
      { workspaceId },
      { $set: { workspaceId: null } },
    );

    // Delete the workspace itself
    await WorkspaceModel.findByIdAndDelete(workspaceId);

    return { success: true };
  }
}

export default new WorkspaceService();
