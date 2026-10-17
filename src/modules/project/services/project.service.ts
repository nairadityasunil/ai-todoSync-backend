import crypto from "node:crypto";
import ProjectModel, {
  type IProjectDocument,
} from "../models/project.model.js";
import type { ProjectRole } from "../models/project-member.model.js";
import {
  findUserById,
  searchUsersByEmail,
} from "../../../modules/auth/repositories/auth.repository.js";
import {
  countProjectsByIds,
  createProject,
  deleteProjectWithRelations,
  deleteProjectsWithRelations,
  getProjectById,
  getProjectByName,
  getProjectsByIds,
  updateProject,
} from "../../../modules/project/repositories/project.repository.js";
import {
  createProjectMember,
  createProjectMembers,
  deleteProjectMembership,
  getProjectMembers,
  getProjectMembership,
  getProjectMembershipsByUser,
} from "../../../modules/project/repositories/project-member.repository.js";
import { clearTaskAssignmentsForUser } from "../../task/repositories/task.repository.js";
import { runInTransaction } from "../../../utils/transaction.js";
import operationalAnalyticsService from "../../analytics/services/operational-analytics.service.js";
import accessService, {
  type WorkspaceAccess,
} from "../../access/access.service.js";
import type { PermissionKey } from "../../access/permissions.js";

interface ProjectDto {
  id: string;
  uuid?: string;
  name: string;
  description?: string;
  userId: string;
  currentUserRole: ProjectRole;
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
  /** The caller's role and permissions in the project's workspace. */
  workspaceAccess: WorkspaceAccess;
}

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class ProjectService {
  /**
   * Creates a project in the caller's workspace (their default workspace for
   * clients that do not send one, e.g. the sync API).
   */
  public async createProject(
    userId: string,
    payload: ProjectPayload,
    workspaceAccess?: WorkspaceAccess,
  ): Promise<ProjectDto> {
    const access =
      workspaceAccess ?? (await accessService.resolveDefault(userId));
    accessService.require(access, "project.create");
    const name = this.normalizeName(payload.name);
    const description =
      typeof payload.description === "string"
        ? payload.description.trim()
        : undefined;

    try {
      const project = await runInTransaction(async (session) => {
        const newProject = await createProject(
          { userId, workspaceId: access.workspaceId, name, description },
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

      operationalAnalyticsService.recordEventSafely({
        eventName: "project_created",
        entityType: "project",
        entityId: project._id.toString(),
        userId,
        projectId: project._id.toString(),
        metadata: { name: project.name },
      });

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

  public async getProject(
    projectId: string,
    userId: string,
  ): Promise<ProjectDto> {
    const { project, role } = await this.getProjectAccess(userId, projectId);
    return this.toDto(project, role);
  }

  /** Projects in the workspace the caller can open (all of them for admins). */
  public async fetchProjects(
    userId: string,
    workspaceAccess?: WorkspaceAccess,
  ): Promise<ProjectDto[]> {
    const access =
      workspaceAccess ?? (await accessService.resolveDefault(userId));
    const projectIds = await accessService.accessibleProjectIds(access);
    const [projects, roles] = await Promise.all([
      getProjectsByIds({ projectIds }),
      this.rolesFor(access),
    ]);
    return projects.map((project) =>
      this.toDto(project, roles(project._id.toString())),
    );
  }

  public async fetchProjectsPaginated(
    userId: string,
    page: number,
    limit: number,
    search?: string,
    workspaceAccess?: WorkspaceAccess,
  ): Promise<PaginatedProjects> {
    const access =
      workspaceAccess ?? (await accessService.resolveDefault(userId));
    const projectIds = await accessService.accessibleProjectIds(access);
    const skip = (page - 1) * limit;
    const [projects, total, roles] = await Promise.all([
      getProjectsByIds({ projectIds, search, skip, limit }),
      countProjectsByIds({ projectIds, search }),
      this.rolesFor(access),
    ]);

    return {
      projects: projects.map((project) =>
        this.toDto(project, roles(project._id.toString())),
      ),
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
    const access = await this.assertProjectPermission(
      userId,
      projectId,
      "project.update",
    );
    const resolvedProjectId = access.project._id.toString();
    const updates: ProjectPayload = {};

    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      updates.name = this.normalizeName(payload.name);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "description")) {
      updates.description =
        typeof payload.description === "string"
          ? payload.description.trim()
          : "";
    }

    try {
      const project = await updateProject(resolvedProjectId, updates);

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
    const access = await this.assertProjectPermission(
      userId,
      projectId,
      "project.delete",
    );
    const resolvedProjectId = access.project._id.toString();
    const project = await deleteProjectWithRelations(resolvedProjectId);

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
        this.assertProjectPermission(userId, projectId, "project.delete"),
      ),
    );

    return deleteProjectsWithRelations(projectIds);
  }

  public async fetchProjectMembers(
    userId: string,
    projectId: string,
  ): Promise<ProjectMemberDto[]> {
    const { project } = await this.assertProjectMembership(userId, projectId);
    const resolvedProjectId = project._id.toString();
    const members = await getProjectMembers(resolvedProjectId);

    return members.map((member) => ({
      id: member.id,
      projectId: project.uuid || member.projectId,
      userId: member.userId,
      role: member.role,
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
    const { workspaceAccess, project } = await this.assertProjectRole(
      actorUserId,
      projectId,
      "ADMIN",
    );
    const resolvedProjectId = project._id.toString();
    const targetUserId = this.normalizeIdentifier(
      payload.userId,
      "User id is required",
    );
    // Members join the workspace first; project access is granted inside it.
    await accessService.assertWorkspaceMember(
      workspaceAccess.workspaceId,
      targetUserId,
    );
    const [user, existingMembership] = await Promise.all([
      findUserById(targetUserId),
      getProjectMembership(resolvedProjectId, targetUserId),
    ]);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    if (existingMembership != null) {
      throw new HttpError(409, "User is already a project member");
    }

    try {
      const member = await createProjectMember({
        projectId: resolvedProjectId,
        userId: targetUserId,
        role: "MEMBER",
        grantedBy: actorUserId,
      });

      return {
        id: member._id.toString(),
        projectId: project.uuid || member.projectId.toString(),
        userId: user._id.toString(),
        role: member.role,
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
    const { project } = await this.assertProjectRole(
      actorUserId,
      projectId,
      "ADMIN",
    );
    const resolvedProjectId = project._id.toString();
    const membership = await getProjectMembership(
      resolvedProjectId,
      targetUserId,
    );

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
        await deleteProjectMembership(resolvedProjectId, targetUserId, session);
        await clearTaskAssignmentsForUser(
          resolvedProjectId,
          targetUserId,
          session,
        );
      });
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  public async leaveProject(userId: string, projectId: string): Promise<void> {
    const { project } = await this.assertProjectMembership(userId, projectId);
    const resolvedProjectId = project._id.toString();
    const membership = await getProjectMembership(resolvedProjectId, userId);

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
        await deleteProjectMembership(resolvedProjectId, userId, session);
        await clearTaskAssignmentsForUser(resolvedProjectId, userId, session);
      });
    } catch (error) {
      throw this.mapPersistenceError(error);
    }
  }

  /** Project role lookup for list views: workspace admins act as project admins. */
  private async rolesFor(
    access: WorkspaceAccess,
  ): Promise<(projectId: string) => ProjectRole> {
    if (access.isAdmin) return () => "ADMIN";
    const memberships = await getProjectMembershipsByUser(access.userId);
    const roles = new Map(
      memberships.map((m) => [m.projectId.toString(), m.role]),
    );
    return (projectId) => roles.get(projectId) ?? "MEMBER";
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

  /**
   * The single gate for project-scoped work (tasks, notes, epics, docs, chat,
   * AI planning, sync). The caller must belong to the project's workspace
   * (otherwise the project "does not exist": 404) and either be a member of
   * the project or a workspace admin (who acts as project admin).
   */
  public async getProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccess> {
    const { access, project } = await accessService.resolveForProject(
      userId,
      projectId,
    );
    const membership = await getProjectMembership(
      project._id.toString(),
      userId,
    );
    const role: ProjectRole = access.isAdmin
      ? "ADMIN"
      : (membership?.role ?? "MEMBER");
    return { project, role, workspaceAccess: access };
  }

  /** Project access plus a workspace permission flag. */
  public async assertProjectPermission(
    userId: string,
    projectId: string,
    ...permissions: PermissionKey[]
  ): Promise<ProjectAccess> {
    const access = await this.getProjectAccess(userId, projectId);
    accessService.require(access.workspaceAccess, ...permissions);
    return access;
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

    // Sync clients have no workspace context: their default workspace.
    const workspaceId = await accessService.defaultWorkspaceId(userId);
    try {
      const project = await runInTransaction(async (session) => {
        const newProject = await createProject(
          {
            userId,
            workspaceId,
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

  private toDto(
    project: IProjectDocument,
    currentUserRole: ProjectRole,
  ): ProjectDto {
    const creatorUser = project.userId as any;
    let effectiveUuid = project.uuid;

    if (!effectiveUuid) {
      effectiveUuid = crypto.randomUUID();
      project.uuid = effectiveUuid;
      void ProjectModel.collection
        .updateOne({ _id: project._id }, { $set: { uuid: effectiveUuid } })
        .catch(() => {});
    }

    const dto: ProjectDto = {
      id: effectiveUuid,
      uuid: effectiveUuid,
      name: project.name,
      description: project.description,
      userId: creatorUser?._id
        ? creatorUser._id.toString()
        : project.userId.toString(),
      currentUserRole,
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

  private normalizeName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";

    if (!name) {
      throw new HttpError(400, "Project name is required");
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
