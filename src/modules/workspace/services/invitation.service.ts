import crypto from "crypto";
import { runInTransaction } from "../../../utils/transaction.js";
import {
  createInvitation,
  getInvitationByToken,
  getInvitationByProjectAndEmail,
  getPendingInvitationsByEmail,
  getPendingInvitationsByProject,
  deleteInvitationById,
} from "../../../modules/workspace/repositories/invitation.repository.js";
import {
  createProjectMember,
  getProjectMembership,
} from "../../../modules/project/repositories/project-member.repository.js";
import { getProjectById } from "../../project/repositories/project.repository.js";
import { findUserByEmail } from "../../auth/repositories/auth.repository.js";
import { invitationQueue } from "./invitation-queue.service.js";
import projectService from "../../project/services/project.service.js";
import activityLogService from "../../audit/services/activity-log.service.js";
import accessService from "../../access/access.service.js";

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export interface InviteUserPayload {
  email: string;
  role?: "ADMIN" | "MEMBER";
}

/** Lazily import the socket server to avoid circular deps */
async function emitToUser(
  userId: string,
  event: string,
  data: unknown,
): Promise<void> {
  try {
    const { default: chatSocketServer } =
      await import("../../../socket/chat.socket.js");
    chatSocketServer.notifyUser(userId, event, data);
  } catch {
    // Non-critical — socket emit failure must not break the flow
  }
}

class InvitationService {
  public async inviteUser(
    actorUserId: string,
    projectId: string,
    payload: InviteUserPayload,
  ): Promise<any> {
    const email = payload.email.toLowerCase().trim();
    const role = payload.role || "MEMBER";

    // 1. Verify that the actor is an ADMIN in the project
    await projectService.assertProjectRole(actorUserId, projectId, "ADMIN");

    // 2. Fetch project details
    const project = await getProjectById(projectId);
    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    // 3. Fetch inviter's details for email personalization
    const { findUserById } =
      await import("../../auth/repositories/auth.repository.js");
    const actorDoc = await findUserById(actorUserId);
    const inviterName = actorDoc?.name || actorDoc?.email || "Someone";

    // 4. Check if target user exists on Pristine
    const targetUser = await findUserByEmail(email);

    if (targetUser) {
      // Check if target user is already a member
      const existingMembership = await getProjectMembership(
        projectId,
        targetUser._id.toString(),
      );
      if (existingMembership) {
        throw new HttpError(409, "User is already a project member");
      }

      // --- Registered user: create pending invitation (NOT direct add) ---
      // so they receive an in-portal notification and can accept/reject
      const token = crypto.randomBytes(32).toString("hex");
      let invitation = await getInvitationByProjectAndEmail(projectId, email);
      if (invitation) {
        if (invitation.status === "ACCEPTED") {
          throw new HttpError(
            409,
            "User has already accepted an invitation to this project",
          );
        }
        invitation.token = token;
        invitation.status = "PENDING";
        invitation.role = role;
        invitation.invitedBy = actorUserId;
        await invitation.save();
      } else {
        invitation = await createInvitation({
          projectId,
          email,
          role,
          token,
          invitedBy: actorUserId,
        });
      }

      // Queue the invitation email (with reject link) for registered users too
      await invitationQueue.add("send-invite-email", {
        email,
        projectName: project.name,
        inviterName,
        token,
      });

      // Push real-time in-portal notification to the invited user
      await emitToUser(targetUser._id.toString(), "invitation:received", {
        invitationId: invitation._id.toString(),
        token: invitation.token,
        projectId,
        projectName: project.name,
        inviterName,
        role,
        createdAt: invitation.createdAt,
      });

      return {
        id: invitation._id.toString(),
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        createdAt: invitation.createdAt,
      };
    }

    // 5. Target user does not exist -> Create/update pending invitation
    const token = crypto.randomBytes(32).toString("hex");

    let invitation = await getInvitationByProjectAndEmail(projectId, email);
    if (invitation) {
      if (invitation.status === "ACCEPTED") {
        throw new HttpError(
          409,
          "User has already accepted an invitation to this project",
        );
      }
      invitation.token = token;
      invitation.status = "PENDING";
      invitation.role = role;
      invitation.invitedBy = actorUserId;
      await invitation.save();
    } else {
      invitation = await createInvitation({
        projectId,
        email,
        role,
        token,
        invitedBy: actorUserId,
      });
    }

    // Queue the invitation email job
    await invitationQueue.add("send-invite-email", {
      email,
      projectName: project.name,
      inviterName,
      token,
    });

    return {
      id: invitation._id.toString(),
      projectId: invitation.projectId
        ? invitation.projectId.toString()
        : projectId,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      createdAt: invitation.createdAt,
    };
  }

  public async verifyInvitationToken(token: string): Promise<any> {
    const invitation = await getInvitationByToken(token);
    if (!invitation) {
      throw new HttpError(404, "Invitation not found or invalid token");
    }

    if (invitation.status !== "PENDING") {
      throw new HttpError(
        400,
        `Invitation is already ${invitation.status.toLowerCase()}`,
      );
    }

    let projectName = "";
    if (invitation.workspaceId) {
      const WorkspaceModel = (await import("../models/workspace.model.js"))
        .default;
      const workspace = await WorkspaceModel.findById(
        invitation.workspaceId.toString(),
      ).lean();
      if (!workspace) throw new HttpError(404, "Workspace no longer exists");
      projectName = workspace.name;
    } else if (invitation.projectId) {
      const project = await getProjectById(invitation.projectId.toString());
      if (!project) {
        throw new HttpError(404, "Project no longer exists");
      }
      projectName = project.name;
    }

    const targetUser = await findUserByEmail(invitation.email);

    return {
      token: invitation.token,
      email: invitation.email,
      projectName,
      role: invitation.role,
      status: invitation.status,
      isRegistered: !!targetUser,
      workspaceId: invitation.workspaceId
        ? invitation.workspaceId.toString()
        : undefined,
    };
  }

  public async acceptInvitation(userId: string, token: string): Promise<any> {
    const invitation = await getInvitationByToken(token);
    if (!invitation) {
      throw new HttpError(404, "Invitation not found or invalid token");
    }

    if (invitation.status !== "PENDING") {
      throw new HttpError(
        400,
        `Invitation is already ${invitation.status.toLowerCase()}`,
      );
    }

    const user = await findUserByEmail(invitation.email);
    if (!user) {
      throw new HttpError(
        400,
        "Invitation email does not match registered user",
      );
    }

    if (user._id.toString() !== userId) {
      throw new HttpError(
        403,
        "You are logged in with a different email than the invited one",
      );
    }

    if (invitation.workspaceId) {
      const workspaceService = (await import("./workspace.service.js")).default;
      await workspaceService.ensureOwnedWorkspace(user._id.toString());

      const WorkspaceMemberModel = (
        await import("../models/workspace-member.model.js")
      ).default;
      await WorkspaceMemberModel.findOneAndUpdate(
        { workspaceId: invitation.workspaceId, userId: user._id },
        {
          $setOnInsert: {
            role: invitation.role || "MEMBER",
            permissions: {},
            joinedAt: new Date(),
          },
        },
        { upsert: true, new: true },
      );
      invitation.status = "ACCEPTED";
      await invitation.save();
      return {
        id: invitation._id.toString(),
        status: "ACCEPTED",
        workspaceId: invitation.workspaceId.toString(),
      };
    }

    // Project access lives inside a workspace: joining a project via an
    // invitation also makes the user a member of the project's workspace.
    if (!invitation.projectId) {
      throw new HttpError(
        400,
        "Invitation has no associated project or workspace",
      );
    }
    const projectId = invitation.projectId.toString();
    const invitedProject = await getProjectById(projectId);
    if (!invitedProject) {
      throw new HttpError(
        404,
        "The project for this invitation no longer exists",
      );
    }
    await accessService.ensureWorkspaceMember(
      await accessService.projectWorkspaceId(invitedProject),
      user._id.toString(),
    );

    const result = await runInTransaction(async (session) => {
      // Create project member
      const existingMembership = await getProjectMembership(
        projectId,
        user._id.toString(),
      );

      if (!existingMembership) {
        await createProjectMember(
          {
            projectId,
            userId: user._id.toString(),
            role: (invitation.role as "ADMIN" | "MEMBER") || "MEMBER",
            grantedBy: invitation.invitedBy?.toString() ?? null,
          },
          session,
        );
      }

      // Update invitation status
      invitation.status = "ACCEPTED";
      await invitation.save({ session });

      // Log activity
      void activityLogService.logActivity({
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "member_added",
        userId: user._id.toString(),
        userName: user.name || user.email,
        description: `joined the project via invitation`,
      });

      return {
        projectId,
        role: invitation.role,
        status: "ACCEPTED",
      };
    });

    // Notify the admin who sent the invite
    const inviterIdStr = invitation.invitedBy?.toString();
    if (inviterIdStr) {
      await emitToUser(inviterIdStr, "invitation:accepted", {
        projectId,
        projectName: invitedProject.name,
        acceptedBy: user.name || user.email,
        acceptedByEmail: user.email,
      });
    }

    return result;
  }

  public async rejectInvitation(userId: string, token: string): Promise<any> {
    const invitation = await getInvitationByToken(token);
    if (!invitation) {
      throw new HttpError(404, "Invitation not found or invalid token");
    }

    if (invitation.status !== "PENDING") {
      throw new HttpError(
        400,
        `Invitation is already ${invitation.status.toLowerCase()}`,
      );
    }

    const user = await findUserByEmail(invitation.email);
    if (!user) {
      throw new HttpError(
        400,
        "Invitation email does not match registered user",
      );
    }

    if (user._id.toString() !== userId) {
      throw new HttpError(
        403,
        "You are logged in with a different email than the invited one",
      );
    }

    invitation.status = "REJECTED";
    await invitation.save();

    // Notify the admin who sent the invite
    const inviterIdStr = invitation.invitedBy?.toString();
    if (inviterIdStr && invitation.projectId) {
      const project = await getProjectById(invitation.projectId.toString());
      await emitToUser(inviterIdStr, "invitation:rejected", {
        projectId: invitation.projectId.toString(),
        projectName: project?.name ?? "the project",
        rejectedBy: user.name || user.email,
        rejectedByEmail: user.email,
      });
    }

    return { status: "REJECTED" };
  }

  /** Public rejection via email link — no user auth required */
  public async rejectInvitationPublic(token: string): Promise<any> {
    const invitation = await getInvitationByToken(token);
    if (!invitation) {
      throw new HttpError(404, "Invitation not found or invalid token");
    }

    if (invitation.status !== "PENDING") {
      throw new HttpError(
        400,
        `Invitation is already ${invitation.status.toLowerCase()}`,
      );
    }

    invitation.status = "REJECTED";
    await invitation.save();

    // Notify admin if possible
    const inviterIdStr = invitation.invitedBy?.toString();
    if (inviterIdStr && invitation.projectId) {
      const project = await getProjectById(invitation.projectId.toString());
      await emitToUser(inviterIdStr, "invitation:rejected", {
        projectId: invitation.projectId.toString(),
        projectName: project?.name ?? "the project",
        rejectedBy: invitation.email,
        rejectedByEmail: invitation.email,
      });
    }

    return { status: "REJECTED" };
  }

  public async revokeInvitation(
    actorUserId: string,
    invitationId: string,
  ): Promise<void> {
    // Load invitation
    const { default: InvitationModel } =
      await import("../models/invitation.model.js");
    const invitation = await InvitationModel.findById(invitationId).exec();
    if (!invitation) {
      throw new HttpError(404, "Invitation not found");
    }

    // Verify actor is admin in that project if it's a project invitation
    if (invitation.projectId) {
      await projectService.assertProjectRole(
        actorUserId,
        invitation.projectId.toString(),
        "ADMIN",
      );
    }

    await deleteInvitationById(invitationId);
  }

  public async getProjectPendingInvitations(
    actorUserId: string,
    projectId: string,
  ): Promise<any[]> {
    await projectService.assertProjectRole(actorUserId, projectId, "ADMIN");
    const invitations = await getPendingInvitationsByProject(projectId);
    return invitations.map((inv) => ({
      id: inv._id.toString(),
      email: inv.email,
      role: inv.role,
      status: inv.status,
      createdAt: inv.createdAt,
    }));
  }

  public async getMyPendingInvitations(email: string): Promise<any[]> {
    const pendingInvites = await getPendingInvitationsByEmail(email);
    const result: any[] = [];
    for (const inv of pendingInvites) {
      if (!inv.projectId) continue;
      const project = await getProjectById(inv.projectId.toString());
      if (!project) continue;
      const { findUserById } =
        await import("../../auth/repositories/auth.repository.js");
      const inviter = await findUserById(inv.invitedBy?.toString() ?? "");
      result.push({
        id: inv._id.toString(),
        token: inv.token,
        projectId: project.uuid || inv.projectId.toString(),
        projectName: project.name,
        inviterName: inviter?.name || inviter?.email || "Someone",
        role: inv.role,
        status: inv.status,
        createdAt: inv.createdAt,
      });
    }
    return result;
  }

  public async handlePostRegistrationInvitations(
    userId: string,
    email: string,
  ): Promise<void> {
    const pendingInvites = await getPendingInvitationsByEmail(email);
    if (pendingInvites.length === 0) {
      return;
    }

    const WorkspaceMemberModel = (
      await import("../models/workspace-member.model.js")
    ).default;
    const workspaceService = (await import("./workspace.service.js")).default;
    await workspaceService.ensureOwnedWorkspace(userId);

    for (const invite of pendingInvites) {
      try {
        if (invite.workspaceId) {
          await WorkspaceMemberModel.findOneAndUpdate(
            { workspaceId: invite.workspaceId, userId },
            {
              $setOnInsert: {
                role: invite.role || "MEMBER",
                permissions: {},
                joinedAt: new Date(),
              },
            },
            { upsert: true, new: true },
          );
          invite.status = "ACCEPTED";
          await invite.save();
          continue;
        }

        if (invite.projectId) {
          const project = await getProjectById(invite.projectId.toString());
          if (!project) continue;
          const { findUserById } =
            await import("../../auth/repositories/auth.repository.js");
          const inviter = await findUserById(
            invite.invitedBy?.toString() ?? "",
          );
          const inviterName = inviter?.name || inviter?.email || "Someone";

          await emitToUser(userId, "invitation:received", {
            invitationId: invite._id.toString(),
            token: invite.token,
            projectId: invite.projectId.toString(),
            projectName: project.name,
            inviterName,
            role: invite.role,
            createdAt: invite.createdAt,
          });
        }
      } catch (err) {
        console.error(
          `Error notifying new user ${email} of pending invite:`,
          err,
        );
      }
    }
  }
}

export default new InvitationService();
