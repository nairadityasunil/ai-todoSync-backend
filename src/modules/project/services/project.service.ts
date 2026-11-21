import { projectCreated } from "../../telemetry/hooks.js";
import ProjectModel, {
  type IProjectDocument,
} from "../models/project.model.js";
import ProjectMemberModel, {
  type ProjectRole,
} from "../models/project-member.model.js";
import ProjectTransferModel from "../models/project-transfer.model.js";
import UserModel from "../../auth/models/user.model.js";
import emailService from "../../../shared/services/email.service.js";
import chatSocketServer from "../../../socket/chat.socket.js";
import activityLogService from "../../audit/services/activity-log.service.js";
import crypto from "node:crypto";
import { Types } from "mongoose";
import {
  findUserById,
  searchUsersByEmail,
} from "../../../modules/auth/repositories/auth.repository.js";
import {
  createProject,
  deleteProjectWithRelations,
  deleteProjectsWithRelations,
  getProjectById,
  getProjectByIdUnpopulated,
  getProjectsPageByIds,
  getProjectByName,
  getProjectsByUser,
  updateProject,
} from "../../../modules/project/repositories/project.repository.js";
import {
  createProjectMember,
  createProjectMembers,
  deleteProjectMembership,
  getProjectMembers,
  getProjectMembership,
  setMemberPermissions,
  getProjectMembershipsByUser,
} from "../../../modules/project/repositories/project-member.repository.js";
import {
  resolvePermissions,
  type ProjectFeature,
  type ProjectPermissions,
} from "../project-permissions.js";
import { requestMemo } from "../../agents/request-context.js";
import { clearTaskAssignmentsForUser } from "../../task/repositories/task.repository.js";
import { runInTransaction } from "../../../utils/transaction.js";
import { ensureDefaultWorkflow } from "../default-workflow.js";
import operationalAnalyticsService from "../../analytics/services/operational-analytics.service.js";
import WorkspaceMemberModel from "../../workspace/models/workspace-member.model.js";

interface ProjectDto {
  id: string;
  name: string;
  description?: string;
  userId: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceAdmin?: {
    id?: string;
    name: string | null;
    email: string;
  };
  isCollaborator?: boolean;
  currentUserRole: ProjectRole;
  /** What the signed-in person may use in this project. */
  currentUserPermissions?: ProjectPermissions;
  classification?: string | null;
  /** False when a project admin has turned SLA tracking off. */
  slaEnabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  creator?: {
    id: string;
    email: string;
    name: string | null;
  };
}

interface ProjectPayload {
  name?: string;
  description?: string;
  workspaceId?: string;
  icon?: string;
  color?: string;
  startDate?: Date;
  targetDate?: Date;
  status?: any;
  priority?: any;
  tags?: string[];
  customFields?: any[];
}

interface AddProjectMemberPayload {
  userId?: unknown;
}

interface ProjectMemberUserDto {
  id: string;
  email: string;
  name: string | null;
}

interface ProjectMemberDto {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  permissions: ProjectPermissions;
  createdAt?: Date;
  user: ProjectMemberUserDto;
}

interface UserSearchDto {
  id: string;
  email: string;
  name: string | null;
}

interface SyncProjectObject {
  name?: unknown;
}

interface PaginatedProjects {
  projects: ProjectDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ProjectAccess {
  project: IProjectDocument;
  role: ProjectRole;
  permissions: ProjectPermissions;
}

import workspaceService from "../../workspace/services/workspace.service.js";

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

/** Long enough for a real name, short enough to fit in lists and the sidebar. */
export const MAX_PROJECT_NAME_LENGTH = 80;
const MAX_PROJECT_DESCRIPTION_LENGTH = 2000;

class ProjectService {
  public async createProject(
    userId: string,
    payload: ProjectPayload,
  ): Promise<ProjectDto> {
    const name = this.normalizeName(payload.name);
    const description =
      typeof payload.description === "string"
        ? payload.description.trim().slice(0, MAX_PROJECT_DESCRIPTION_LENGTH)
        : undefined;

    let targetWorkspaceId = payload.workspaceId;
    if (!targetWorkspaceId) {
      try {
        const defaultWs =
          await workspaceService.getOrCreateDefaultWorkspace(userId);
        targetWorkspaceId = defaultWs._id
          ? defaultWs._id.toString()
          : undefined;
      } catch (err) {
        console.error(
          "Failed to resolve default workspace for project creation",
          err,
        );
      }
    }

    if (targetWorkspaceId) {
      const wsMember = await WorkspaceMemberModel.findOne({
        workspaceId: targetWorkspaceId,
        userId,
      }).lean();
      if (!wsMember) {
        throw new HttpError(
          403,
          "You cannot create a project in a workspace you are not a member of.",
        );
      }
      if (
        wsMember.role !== "OWNER" &&
        wsMember.role !== "ADMIN" &&
        wsMember.permissions?.projects === false
      ) {
        throw new HttpError(
          403,
          "You do not have permission to create projects in this workspace.",
        );
      }
    }

    try {
      const project = await runInTransaction(async (session) => {
        const newProject = await createProject(
          { userId, name, description, workspaceId: targetWorkspaceId },
          session,
        );

        await createProjectMember(
          {
            projectId: newProject._id.toString(),
            userId,
            role: "ADMIN",
          },
          session,
        );

        return newProject;
      });

      if (project == null) {
        throw new HttpError(500, "Project could not be created");
      }

      // Same four stages everywhere (settings, board, task status) from the start.
      await ensureDefaultWorkflow(project._id.toString());

      operationalAnalyticsService.recordEventSafely({
        eventName: "project_created",
        entityType: "project",
        entityId: project._id.toString(),
        userId,
        projectId: project._id.toString(),
        metadata: { name: project.name },
      });

      // A governance checklist for the new project (see telemetry/automation).
      projectCreated(
        {
          id: project._id.toString(),
          name: project.name,
          workspaceId: project.workspaceId
            ? project.workspaceId.toString()
            : null,
        },
        userId,
      );

      return this.toDto(project, "ADMIN");
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  public async getProjectById(
    projectId: string,
  ): Promise<IProjectDocument | null> {
    return getProjectById(projectId);
  }

  public async fetchProjects(userId: string): Promise<ProjectDto[]> {
    const [projects, memberships] = await Promise.all([
      getProjectsByUser({ userId }),
      getProjectMembershipsByUser(userId),
    ]);
    const membershipByProject = new Map(
      memberships.map((membership) => [
        membership.projectId.toString(),
        membership.role,
      ]),
    );

    return projects
      .map((project) => {
        const role = membershipByProject.get(project._id.toString());
        return role ? this.toDto(project, role) : null;
      })
      .filter((project): project is ProjectDto => project != null);
  }

  public async fetchProjectsPaginated(
    userId: string,
    page: number,
    limit: number,
    search?: string,
    workspaceId?: string,
    scope?: "workspace" | "collaborating",
  ): Promise<PaginatedProjects> {
    const skip = (page - 1) * limit;
    // Memberships give both the project ids and the user's roles, so load
    // them once and then fetch the page and total together.
    const memberships = await getProjectMembershipsByUser(userId);

    let excludeWorkspaceIds: string[] | undefined = undefined;
    const userWorkspaces = await WorkspaceMemberModel.find({ userId })
      .select({ workspaceId: 1 })
      .lean()
      .exec();
    const userWsSet = new Set(
      userWorkspaces.map((w) => w.workspaceId.toString()),
    );

    if (scope === "collaborating") {
      excludeWorkspaceIds = Array.from(userWsSet);
      workspaceId = undefined;
    }

    const { projects, total } = await getProjectsPageByIds({
      projectIds: memberships.map((membership) =>
        membership.projectId.toString(),
      ),
      search,
      workspaceId,
      excludeWorkspaceIds,
      skip,
      limit,
    });
    const membershipByProject = new Map(
      memberships.map((membership) => [
        membership.projectId.toString(),
        membership,
      ]),
    );

    const wsIds = Array.from(
      new Set(
        projects
          .map((p) => p.workspaceId?.toString())
          .filter((id): id is string => Boolean(id)),
      ),
    );

    let wsMap = new Map<
      string,
      {
        name: string;
        admin?: { id: string; name: string | null; email: string };
      }
    >();

    if (wsIds.length > 0) {
      try {
        const WorkspaceModel = (
          await import("../../workspace/models/workspace.model.js")
        ).default;
        const workspaces = await WorkspaceModel.find({
          _id: { $in: wsIds },
        })
          .populate("ownerId", "name email")
          .lean();

        wsMap = new Map(
          workspaces.map((w: any) => [
            w._id.toString(),
            {
              name: w.name,
              admin: w.ownerId
                ? {
                    id: w.ownerId._id?.toString() || w.ownerId.toString(),
                    name: w.ownerId.name || null,
                    email: w.ownerId.email || "",
                  }
                : undefined,
            },
          ]),
        );
      } catch (err) {
        console.error("Failed to populate workspace info for projects", err);
      }
    }

    return {
      projects: projects
        .map((project) => {
          const membership = membershipByProject.get(project._id.toString());
          const isCollaborator =
            !project.workspaceId ||
            !userWsSet.has(project.workspaceId.toString());
          const wsInfo = project.workspaceId
            ? wsMap.get(project.workspaceId.toString())
            : undefined;
          return membership
            ? ({
                ...this.toDto(project, membership.role, isCollaborator),
                workspaceName: wsInfo?.name,
                workspaceAdmin: wsInfo?.admin,
                currentUserPermissions: resolvePermissions(
                  membership.role,
                  membership.permissions,
                ),
              } as ProjectDto)
            : null;
        })
        .filter((project): project is ProjectDto => project != null),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  public async updateProject(
    projectId: string,
    userId: string,
    payload: ProjectPayload,
  ): Promise<ProjectDto> {
    const access = await this.assertProjectRole(userId, projectId, "ADMIN");
    const updates: ProjectPayload = {};

    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      updates.name = this.normalizeName(payload.name);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "description")) {
      updates.description =
        typeof payload.description === "string"
          ? payload.description.trim().slice(0, MAX_PROJECT_DESCRIPTION_LENGTH)
          : "";
    }

    try {
      const project = await updateProject(projectId, updates);

      if (project == null) {
        throw new HttpError(404, "Project not found");
      }

      return this.toDto(project, access.role);
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  public async deleteProject(
    projectId: string,
    userId: string,
  ): Promise<IProjectDocument> {
    await this.assertProjectOwnership(userId, projectId);
    const project = await deleteProjectWithRelations(projectId);

    if (project == null) {
      throw new HttpError(404, "Project not found");
    }

    return project;
  }

  public async bulkDeleteProjects(
    userId: string,
    projectIds: string[],
  ): Promise<number> {
    if (projectIds.length === 0) {
      return 0;
    }

    await Promise.all(
      projectIds.map((projectId) =>
        this.assertProjectRole(userId, projectId, "ADMIN"),
      ),
    );

    return deleteProjectsWithRelations(projectIds);
  }

  public async fetchProjectMembers(
    userId: string,
    projectId: string,
  ): Promise<ProjectMemberDto[]> {
    await this.assertProjectMembership(userId, projectId);
    const members = await getProjectMembers(projectId);

    return members.map((member) => ({
      id: member.id,
      projectId: member.projectId,
      userId: member.userId,
      role: member.role,
      permissions: resolvePermissions(member.role, member.permissions),
      createdAt: member.createdAt,
      user: {
        id: member.user._id.toString(),
        email: member.user.email,
        name: member.user.name ?? null,
      },
    }));
  }

  public async addProjectMember(
    actorUserId: string,
    projectId: string,
    payload: AddProjectMemberPayload,
  ): Promise<ProjectMemberDto> {
    await this.assertProjectRole(actorUserId, projectId, "ADMIN");
    const targetUserId = this.normalizeIdentifier(
      payload.userId,
      "User id is required",
    );
    const [user, existingMembership] = await Promise.all([
      findUserById(targetUserId),
      getProjectMembership(projectId, targetUserId),
    ]);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    if (existingMembership != null) {
      throw new HttpError(409, "User is already a project member");
    }

    // Project members can be workspace members or outside collaborators.
    // Membership is scoped strictly to this project.

    try {
      const member = await createProjectMember({
        projectId,
        userId: targetUserId,
        role: "MEMBER",
      });

      return {
        id: member._id.toString(),
        projectId: member.projectId.toString(),
        userId: user._id.toString(),
        role: member.role,
        permissions: resolvePermissions(member.role, member.permissions),
        createdAt: member.createdAt,
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name ?? null,
        },
      };
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  public async removeProjectMember(
    actorUserId: string,
    projectId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.assertProjectRole(actorUserId, projectId, "ADMIN");
    const membership = await getProjectMembership(projectId, targetUserId);

    if (membership == null) {
      throw new HttpError(404, "Project member not found");
    }

    if (membership.role === "ADMIN") {
      throw new HttpError(
        409,
        "Project admins cannot be removed from the team",
      );
    }

    try {
      await runInTransaction(async (session) => {
        await deleteProjectMembership(projectId, targetUserId, session);
        await clearTaskAssignmentsForUser(projectId, targetUserId, session);
      });
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  public async leaveProject(userId: string, projectId: string): Promise<void> {
    const membership = await getProjectMembership(projectId, userId);

    if (membership == null) {
      throw new HttpError(404, "You are not a member of this project");
    }

    if (membership.role === "ADMIN") {
      throw new HttpError(
        409,
        "Project admins cannot leave. They must delete the project.",
      );
    }

    try {
      await runInTransaction(async (session) => {
        await deleteProjectMembership(projectId, userId, session);
        await clearTaskAssignmentsForUser(projectId, userId, session);
      });
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  public async searchRegisteredUsersByEmail(
    query: unknown,
  ): Promise<UserSearchDto[]> {
    if (typeof query !== "string" || query.trim().length < 2) {
      throw new HttpError(400, "Email query must be at least 2 characters");
    }

    const users = await searchUsersByEmail(query.trim(), 10);
    return users.map((user) => ({
      id: user._id.toString(),
      email: user.email,
      name: user.name ?? null,
    }));
  }

  public getProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccess> {
    // The route middleware and the service behind it both check access: do it once per request.
    return requestMemo(`project-access:${userId}:${projectId}`, () =>
      this.loadProjectAccess(userId, projectId),
    );
  }

  private async loadProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccess> {
    // Access checks run on almost every project request; skip populating
    // the creator, which they never use.
    const [project, membership] = await Promise.all([
      getProjectByIdUnpopulated(projectId),
      getProjectMembership(projectId, userId),
    ]);

    if (project == null) {
      throw new HttpError(404, "Project not found");
    }

    if (membership == null) {
      throw new HttpError(403, "Project access denied");
    }

    return {
      project,
      role: membership.role,
      permissions: resolvePermissions(membership.role, membership.permissions),
    };
  }

  /** The person must be a project admin or have been given this feature by one. */
  public async assertProjectPermission(
    userId: string,
    projectId: string,
    feature: ProjectFeature,
  ): Promise<ProjectAccess> {
    const access = await this.getProjectAccess(userId, projectId);
    if (!access.permissions[feature]) {
      throw new HttpError(
        403,
        "A project admin has not given you access to this feature",
      );
    }
    return access;
  }

  /** A project admin sets which features a member may use. Admins always have all of them. */
  public async updateMemberPermissions(
    actorUserId: string,
    projectId: string,
    targetUserId: string,
    patch: Partial<ProjectPermissions>,
  ): Promise<ProjectMemberDto> {
    await this.assertProjectRole(actorUserId, projectId, "ADMIN");
    const membership = await getProjectMembership(projectId, targetUserId);
    if (membership == null)
      throw new HttpError(404, "Project member not found");
    if (membership.role === "ADMIN")
      throw new HttpError(409, "Project admins always have every feature");
    if (Object.keys(patch).length === 0)
      throw new HttpError(
        400,
        "Send at least one of team, time, prompts, aiPlanner",
      );
    await setMemberPermissions(projectId, targetUserId, patch);
    const members = await this.fetchProjectMembers(actorUserId, projectId);
    const updated = members.find((m) => m.userId === targetUserId);
    if (!updated) throw new HttpError(404, "Project member not found");
    return updated;
  }

  public async assertProjectMembership(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccess> {
    return this.getProjectAccess(userId, projectId);
  }

  public async assertProjectRole(
    userId: string,
    projectId: string,
    requiredRole: ProjectRole,
  ): Promise<ProjectAccess> {
    const access = await this.getProjectAccess(userId, projectId);
    const roleOrder: Record<ProjectRole, number> = {
      MEMBER: 1,
      ADMIN: 2,
    };

    if (roleOrder[access.role] < roleOrder[requiredRole]) {
      throw new HttpError(403, "Insufficient project role");
    }

    return access;
  }

  public async assertProjectOwnership(
    userId: string,
    projectId: string,
  ): Promise<void> {
    await this.assertProjectRole(userId, projectId, "ADMIN");
  }

  public async resolveProjectForSync(
    userId: string,
    value: unknown,
  ): Promise<string | null | undefined> {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    if (typeof value === "string") {
      const name = this.normalizeName(value);
      const project = await this.ensureProjectByName(userId, name);
      return project._id.toString();
    }

    if (typeof value === "object") {
      const projectObject = value as SyncProjectObject;
      const name = this.normalizeName(projectObject.name);
      const project = await this.ensureProjectByName(userId, name);
      return project._id.toString();
    }

    throw new HttpError(400, "Invalid project value");
  }

  private async ensureProjectByName(
    userId: string,
    name: string,
  ): Promise<IProjectDocument> {
    const existingProject = await getProjectByName(userId, name);

    if (existingProject != null) {
      const membership = await getProjectMembership(
        existingProject._id.toString(),
        userId,
      );

      if (membership == null) {
        await createProjectMembers([
          {
            projectId: existingProject._id.toString(),
            userId,
            role: "ADMIN",
          },
        ]);
      }

      return existingProject;
    }

    try {
      const project = await runInTransaction(async (session) => {
        const newProject = await createProject(
          {
            userId,
            name,
          },
          session,
        );
        await createProjectMember(
          {
            projectId: newProject._id.toString(),
            userId,
            role: "ADMIN",
          },
          session,
        );
        return newProject;
      });

      if (project == null) {
        throw new HttpError(500, "Project not created");
      }

      return project;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const project = await getProjectByName(userId, name);

        if (project != null) {
          return project;
        }
      }

      throw this.mapPersistenceError(error);
    }
  }

  /** One project the person belongs to, so a project beyond the first page of the list can still be opened. */
  public async getProjectForUser(
    userId: string,
    projectId: string,
  ): Promise<ProjectDto> {
    const { project, role, permissions } = await this.getProjectAccess(
      userId,
      projectId,
    );
    return {
      ...this.toDto(project, role),
      currentUserPermissions: permissions,
    };
  }

  private toDto(
    project: IProjectDocument,
    currentUserRole: ProjectRole,
    isCollaborator?: boolean,
  ): ProjectDto {
    const creatorUser = project.userId as any;
    const dto: ProjectDto = {
      id: project._id.toString(),
      name: project.name,
      description: project.description,
      userId: creatorUser?._id
        ? creatorUser._id.toString()
        : project.userId.toString(),
      workspaceId: project.workspaceId
        ? project.workspaceId.toString()
        : undefined,
      isCollaborator: isCollaborator ?? false,
      currentUserRole,
      classification: project.classification ?? null,
      slaEnabled: project.slaEnabled !== false,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };

    if (creatorUser?._id) {
      dto.creator = {
        id: creatorUser._id.toString(),
        email: creatorUser.email,
        name: creatorUser.name ?? null,
      };
    }

    return dto;
  }

  public async initiateOwnershipTransfer(
    actorUserId: string,
    projectId: string,
    targetEmail: string,
  ): Promise<any> {
    const email = targetEmail.trim().toLowerCase();
    if (!email) {
      throw new HttpError(400, "Recipient email is required");
    }

    const project = await getProjectById(projectId);
    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    // Must be the current owner
    const currentOwnerId = (
      (project.userId as any)?._id || project.userId
    ).toString();
    if (currentOwnerId !== actorUserId) {
      throw new HttpError(
        403,
        "Only the project owner can transfer ownership of this project.",
      );
    }

    const targetUser = await UserModel.findOne({ email }).lean();
    if (!targetUser) {
      throw new HttpError(
        404,
        "User not found. The new owner must have an existing account on Pristine.",
      );
    }

    if (targetUser._id.toString() === actorUserId) {
      throw new HttpError(400, "You are already the owner of this project.");
    }

    // Only one invitation should be sent, and transfer remains locked till previous one is rejected
    const activeTransfer = await ProjectTransferModel.findOne({
      projectId: project._id,
      status: "PENDING",
      expiresAt: { $gt: new Date() },
    });
    if (activeTransfer) {
      throw new HttpError(
        409,
        `An ownership transfer invitation is already pending for this project (sent to ${activeTransfer.targetEmail}). A transfer remains locked until the previous invitation is rejected.`,
      );
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const transfer = await ProjectTransferModel.create({
      projectId: project._id,
      currentOwnerId: actorUserId,
      targetUserId: targetUser._id,
      targetEmail: email,
      token,
      status: "PENDING",
      expiresAt,
    });

    // Fetch actor details
    const actorDoc = await findUserById(actorUserId);
    const actorName = actorDoc?.name || actorDoc?.email || "Current Owner";

    // Send email with accept & reject links
    const frontendBase =
      process.env.FRONTEND_BASE_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:5173";
    const acceptUrl = `${frontendBase}/projects/transfer/${token}?action=accept`;
    const rejectUrl = `${frontendBase}/projects/transfer/${token}?action=reject`;

    const subject = `Transfer of project ownership: ${project.name}`;
    const text = `Hello,\n\n${actorName} wants to transfer ownership of the project "${project.name}" to you on Pristine.\n\nAccept: ${acceptUrl}\nReject: ${rejectUrl}\n\nThis request expires in 7 days.`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #0f172a;">Project Ownership Transfer</h2>
        <p style="color: #334155; font-size: 15px; line-height: 1.6;">
          <strong>${actorName}</strong> has requested to transfer ownership of the project <strong>${project.name}</strong> to you on Pristine.
        </p>
        <p style="color: #475569; font-size: 14px; line-height: 1.5;">
          When you accept, the project will become part of your default workspace with all its tasks, epics, time sheets, and members preserved.
        </p>
        <div style="margin: 25px 0;">
          <a href="${acceptUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Accept Ownership</a>
          &nbsp;&nbsp;
          <a href="${rejectUrl}" style="background-color: #f1f5f9; color: #475569; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Reject</a>
        </div>
        <p style="color: #94a3b8; font-size: 13px;">This transfer request will expire in 7 days.</p>
      </div>
    `;

    void emailService.sendEmail(email, subject, text, html);

    // Send in-app notification via socket to the proposed new owner
    chatSocketServer.notifyUser(
      targetUser._id.toString(),
      "project:transfer_request",
      {
        id: transfer._id.toString(),
        token,
        projectId: project._id.toString(),
        projectName: project.name,
        projectDescription: project.description || "",
        currentOwnerName: actorName,
        currentOwnerEmail: actorDoc?.email || "",
        targetEmail: email,
        status: "PENDING",
        createdAt: transfer.createdAt || new Date(),
        expiresAt,
      },
    );

    return {
      id: transfer._id.toString(),
      projectId: project._id.toString(),
      projectName: project.name,
      targetEmail: email,
      status: transfer.status,
      expiresAt,
    };
  }

  public async getTransferDetails(token: string) {
    const transfer = await ProjectTransferModel.findOne({ token }).lean();
    if (!transfer) {
      throw new HttpError(404, "Transfer request not found or invalid token");
    }

    const project = await ProjectModel.findById(transfer.projectId)
      .select("name description")
      .lean();
    const currentOwner = await UserModel.findById(transfer.currentOwnerId)
      .select("name email")
      .lean();

    return {
      id: transfer._id.toString(),
      token: transfer.token,
      projectId: transfer.projectId.toString(),
      projectName: project?.name || "Unknown Project",
      projectDescription: project?.description || "",
      currentOwnerName: currentOwner?.name || currentOwner?.email || "Someone",
      currentOwnerEmail: currentOwner?.email || "",
      targetEmail: transfer.targetEmail,
      status: transfer.status,
      isExpired: new Date() > new Date(transfer.expiresAt),
      expiresAt: transfer.expiresAt,
    };
  }

  public async acceptOwnershipTransfer(
    token: string,
    acceptingUserId: string,
  ): Promise<any> {
    const transfer = await ProjectTransferModel.findOne({ token });
    if (!transfer) {
      throw new HttpError(404, "Transfer request not found or invalid token");
    }

    if (transfer.status !== "PENDING") {
      throw new HttpError(
        400,
        `Transfer request has already been ${transfer.status.toLowerCase()}`,
      );
    }

    if (new Date() > new Date(transfer.expiresAt)) {
      throw new HttpError(
        410,
        "This transfer request has expired. Please ask the owner to send a new one.",
      );
    }

    const acceptingUser = await UserModel.findById(acceptingUserId).lean();
    if (!acceptingUser) {
      throw new HttpError(404, "Accepting user not found");
    }

    if (
      transfer.targetUserId &&
      transfer.targetUserId.toString() !== acceptingUserId &&
      acceptingUser.email.toLowerCase() !== transfer.targetEmail.toLowerCase()
    ) {
      throw new HttpError(
        403,
        "You are not authorized to accept this transfer request",
      );
    }

    const project = await ProjectModel.findById(transfer.projectId);
    if (!project) {
      throw new HttpError(404, "Project no longer exists");
    }

    // Resolve target user's default workspace
    const targetWorkspace =
      await workspaceService.getOrCreateDefaultWorkspace(acceptingUserId);
    const newWorkspaceId = targetWorkspace._id;

    const oldOwnerId = transfer.currentOwnerId.toString();

    await runInTransaction(async (session) => {
      // 1. Transfer project ownership and workspace
      project.userId = new Types.ObjectId(acceptingUserId);
      project.workspaceId = newWorkspaceId;
      await project.save({ session });

      // 2. Transfer associated ProjectPlan if exists
      const ProjectPlanModel = (await import("../models/project-plan.model.js"))
        .default;
      await ProjectPlanModel.updateMany(
        { projectId: project._id },
        { $set: { workspaceId: newWorkspaceId } },
        { session },
      );

      // 3. Promote new owner to ADMIN in ProjectMemberModel
      await ProjectMemberModel.findOneAndUpdate(
        { projectId: project._id, userId: new Types.ObjectId(acceptingUserId) },
        {
          $set: {
            projectId: project._id,
            userId: new Types.ObjectId(acceptingUserId),
            role: "ADMIN",
            permissions: {
              team: true,
              time: true,
              prompts: true,
              aiPlanner: true,
            },
          },
        },
        { upsert: true, session },
      );

      // 4. Demote old owner to 2nd highest role (MEMBER) instantly
      await ProjectMemberModel.findOneAndUpdate(
        { projectId: project._id, userId: new Types.ObjectId(oldOwnerId) },
        {
          $set: {
            role: "MEMBER",
            permissions: {
              team: false,
              time: true,
              prompts: false,
              aiPlanner: false,
            },
          },
        },
        { session },
      );

      // 5. Update transfer status
      transfer.status = "ACCEPTED";
      await transfer.save({ session });
    });

    // Real-time socket notification to the previous owner:
    // Demote their role instantly so client disables admin controls without refresh
    chatSocketServer.notifyUser(oldOwnerId, "project:ownership_transferred", {
      projectId: project._id.toString(),
      newOwnerId: acceptingUserId,
      role: "MEMBER",
      permissions: {
        team: false,
        time: true,
        prompts: false,
        aiPlanner: false,
      },
    });

    // Notify the new owner
    chatSocketServer.notifyUser(acceptingUserId, "project:ownership_accepted", {
      projectId: project._id.toString(),
      projectName: project.name,
      workspaceId: newWorkspaceId.toString(),
    });

    // Notify project room
    void chatSocketServer.emitSystemMessage(
      project._id.toString(),
      `Project ownership was transferred to ${acceptingUser.name || acceptingUser.email}.`,
      { type: "ownership_transferred", newOwnerId: acceptingUserId },
    );

    // Log activity
    void activityLogService.logActivity({
      projectId: project._id.toString(),
      entityType: "project",
      entityId: project._id.toString(),
      entityName: project.name,
      action: "updated",
      userId: acceptingUserId,
      userName: acceptingUser.name || acceptingUser.email,
      description: `transferred project ownership to ${acceptingUser.name || acceptingUser.email}`,
    });

    return {
      projectId: project._id.toString(),
      projectName: project.name,
      workspaceId: newWorkspaceId.toString(),
      newOwnerId: acceptingUserId,
      message: "Project ownership transferred successfully",
    };
  }

  public async rejectOwnershipTransfer(
    token: string,
    _rejectingUserId?: string,
  ): Promise<any> {
    const transfer = await ProjectTransferModel.findOne({ token });
    if (!transfer) {
      throw new HttpError(404, "Transfer request not found or invalid token");
    }

    if (transfer.status !== "PENDING") {
      throw new HttpError(
        400,
        `Transfer request has already been ${transfer.status.toLowerCase()}`,
      );
    }

    transfer.status = "REJECTED";
    await transfer.save();

    // Notify previous owner
    chatSocketServer.notifyUser(
      transfer.currentOwnerId.toString(),
      "project:transfer_rejected",
      {
        projectId: transfer.projectId.toString(),
        targetEmail: transfer.targetEmail,
      },
    );

    return {
      projectId: transfer.projectId.toString(),
      status: "REJECTED",
      message: "Transfer request rejected",
    };
  }

  public async getActiveTransferForProject(projectId: string) {
    const transfer = await ProjectTransferModel.findOne({
      projectId,
      status: "PENDING",
      expiresAt: { $gt: new Date() },
    })
      .populate("targetUserId", "name email")
      .lean();

    if (!transfer) return null;
    return {
      id: transfer._id.toString(),
      targetEmail: transfer.targetEmail,
      targetUserName: (transfer.targetUserId as any)?.name || null,
      status: transfer.status,
      createdAt: transfer.createdAt,
      expiresAt: transfer.expiresAt,
    };
  }

  public async getMyPendingTransfers(userId: string, email: string) {
    const targetUserIdConditions: any[] = [];
    if (userId) {
      targetUserIdConditions.push({ targetUserId: userId });
      if (Types.ObjectId.isValid(userId)) {
        targetUserIdConditions.push({
          targetUserId: new Types.ObjectId(userId),
        });
      }
    }
    const emailNorm = (email || "").toLowerCase().trim();
    const query: any = {
      $or: [
        ...targetUserIdConditions,
        ...(emailNorm ? [{ targetEmail: emailNorm }] : []),
      ],
      status: "PENDING",
      expiresAt: { $gt: new Date() },
    };

    const transfers = await ProjectTransferModel.find(query)
      .populate("projectId", "name description")
      .populate("currentOwnerId", "name email")
      .lean();

    return transfers.map((t: any) => ({
      id: t._id.toString(),
      token: t.token,
      projectId: t.projectId?._id?.toString() || t.projectId?.toString(),
      projectName: t.projectId?.name || "Unknown Project",
      projectDescription: t.projectId?.description || "",
      currentOwnerName:
        t.currentOwnerId?.name || t.currentOwnerId?.email || "Someone",
      currentOwnerEmail: t.currentOwnerId?.email || "",
      targetEmail: t.targetEmail,
      status: t.status,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    }));
  }

  private normalizeName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";

    if (!name) {
      throw new HttpError(400, "Project name is required");
    }
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      throw new HttpError(
        400,
        `Project name can be at most ${MAX_PROJECT_NAME_LENGTH} characters (this one has ${name.length}).`,
      );
    }

    return name;
  }

  private normalizeIdentifier(value: unknown, message: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(400, message);
    }

    return value.trim();
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error != null &&
      "code" in error &&
      error.code === 11000
    );
  }

  private mapPersistenceError(error: unknown): Error {
    if (this.isDuplicateKeyError(error)) {
      return new HttpError(409, "Project name already exists");
    }

    return error instanceof Error ? error : new Error("Unknown error");
  }
}

const projectService = new ProjectService();

export type {
  ProjectDto,
  ProjectMemberDto,
  ProjectMemberUserDto,
  ProjectPayload,
  UserSearchDto,
};
export default projectService;
