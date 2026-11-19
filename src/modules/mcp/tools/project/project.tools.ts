/**
 * Work Management — Project domain MCP tools.
 */

import toolRegistry from "../../registry/tool-registry.js";
import projectService from "../../../project/services/project.service.js";
import epicService from "../../../epic/services/epic.service.js";
import taskService from "../../../task/services/task.service.js";
import slaService from "../../../task/services/sla.service.js";
import semanticIntelligenceService from "../../../ai/services/semantic-intelligence.service.js";

// --- READ TOOLS ---

toolRegistry.register({
  name: "project:list",
  description:
    "List all projects the authenticated user belongs to, including their role in each project.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId) => {
    const projects = await projectService.fetchProjects(userId);
    return { projects };
  },
});

toolRegistry.register({
  name: "project:get",
  description:
    "Get metadata for a specific project by ID. Returns name, description, status, role, and timestamps.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId } = input as { projectId: string };
    const access = await projectService.getProjectAccess(userId, projectId);
    return {
      id: access.project._id.toString(),
      name: access.project.name,
      description: access.project.description,
      role: access.role,
      createdAt: access.project.createdAt,
      updatedAt: access.project.updatedAt,
    };
  },
});

toolRegistry.register({
  name: "project:get_context",
  description:
    "Get comprehensive context for a project: metadata, epics, recent tasks, member count, SLA analytics, and health report. Designed as a single AI context-gathering call to avoid repeated lookups.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
      taskLimit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId, taskLimit = 20 } = input as {
      projectId: string;
      taskLimit?: number;
    };

    await projectService.assertProjectMembership(userId, projectId);

    const [access, epics, tasks, slaAnalytics, healthReport] =
      await Promise.all([
        projectService.getProjectAccess(userId, projectId),
        epicService.fetchProjectEpics(userId, projectId),
        taskService.fetchTasks(userId),
        slaService.getAnalytics(userId, { projectId }).catch(() => null),
        semanticIntelligenceService.generateReport(projectId).catch(() => null),
      ]);

    const projectTasks = tasks
      .filter((t) => t.projectId === projectId)
      .slice(0, taskLimit);

    const members = await projectService.fetchProjectMembers(userId, projectId);

    return {
      project: {
        id: access.project._id.toString(),
        name: access.project.name,
        description: access.project.description,
        role: access.role,
      },
      epics,
      recentTasks: projectTasks,
      memberCount: members.length,
      slaAnalytics,
      healthReport,
    };
  },
});

toolRegistry.register({
  name: "project:list_members",
  description:
    "List all members of a project including their roles and user information.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId } = input as { projectId: string };
    const members = await projectService.fetchProjectMembers(userId, projectId);
    return { members };
  },
});

toolRegistry.register({
  name: "project:get_health",
  description:
    "Get health report for a project: health score (0-100), planned vs actual hours, task breakdown, identified risks, and actionable recommendations.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId } = input as { projectId: string };
    await projectService.assertProjectMembership(userId, projectId);
    return semanticIntelligenceService.generateReport(projectId);
  },
});

toolRegistry.register({
  name: "project:get_risks",
  description:
    "Get identified risks for a project with severity levels and impact descriptions.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId } = input as { projectId: string };
    await projectService.assertProjectMembership(userId, projectId);
    const report = await semanticIntelligenceService.generateReport(projectId);
    return { risks: report.risks, recommendations: report.recommendations };
  },
});

toolRegistry.register({
  name: "project:list_blocked",
  description: "List all blocked tasks within a specific project.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId, limit = 20 } = input as {
      projectId: string;
      limit?: number;
    };
    await projectService.assertProjectMembership(userId, projectId);
    const tasks = await taskService.fetchTasks(userId);
    const blocked = tasks
      .filter((t) => t.projectId === projectId && t.isBlocked)
      .slice(0, limit);
    return { tasks: blocked, total: blocked.length };
  },
});

toolRegistry.register({
  name: "project:list_overdue",
  description:
    "List all overdue tasks within a specific project (past due date, not completed).",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId, limit = 20 } = input as {
      projectId: string;
      limit?: number;
    };
    await projectService.assertProjectMembership(userId, projectId);
    const today = new Date().toISOString().split("T")[0];
    const tasks = await taskService.fetchTasks(userId);
    const overdue = tasks
      .filter(
        (t) =>
          t.projectId === projectId &&
          t.date &&
          t.date < today &&
          t.status !== "DONE" &&
          t.status !== "rolled_over",
      )
      .slice(0, limit);
    return { tasks: overdue, total: overdue.length };
  },
});

// --- WRITE TOOLS ---

toolRegistry.register({
  name: "project:create",
  description:
    "Create a new project. The authenticated user becomes the project ADMIN.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const { name, description } = input as {
      name: string;
      description?: string;
    };
    return projectService.createProject(userId, { name, description });
  },
});

toolRegistry.register({
  name: "project:update",
  description:
    "Update a project's name or description. Requires ADMIN role in the project.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const { projectId, ...updates } = input as {
      projectId: string;
      [k: string]: unknown;
    };
    return projectService.updateProject(userId, projectId, updates as any);
  },
});

// --- SENSITIVE WRITE TOOLS ---

toolRegistry.register({
  name: "project:add_member",
  description:
    "Add a user to a project by email address. Requires ADMIN role. Confirmation required before execution.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "email"],
    properties: {
      projectId: { type: "string" },
      email: { type: "string" },
      _confirmationToken: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "sensitive_write",
  requiresConfirmation: true,
  handler: async (userId, input) => {
    const { projectId, email } = input as {
      projectId: string;
      email: string;
    };
    // Find user by email first
    const users = await projectService.searchRegisteredUsersByEmail(email);
    const targetUser = users[0];
    if (!targetUser) {
      const err = new Error(`No registered user found with email: ${email}`);
      (err as any).status = 404;
      throw err;
    }
    return projectService.addProjectMember(userId, projectId, {
      userId: targetUser.id,
    });
  },
});

// --- DESTRUCTIVE TOOLS ---

toolRegistry.register({
  name: "project:delete",
  description:
    "Permanently delete a project and all associated tasks, epics, notes, and members. This is irreversible. Requires ADMIN role and confirmation token.",
  domain: "project",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
      _confirmationToken: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "destructive",
  requiresConfirmation: true,
  handler: async (userId, input) => {
    const { projectId } = input as { projectId: string };
    await projectService.deleteProject(userId, projectId);
    return { deleted: true, projectId };
  },
});
