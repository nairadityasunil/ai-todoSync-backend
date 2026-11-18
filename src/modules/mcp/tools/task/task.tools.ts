/**
 * Work Management — Task domain MCP tools.
 * All operations delegate to taskService, slaService, and priorityEngineService.
 * No duplicate business logic. Permissions enforced by existing service layer.
 */

import toolRegistry from "../../registry/tool-registry.js";
import taskService from "../../../task/services/task.service.js";
import slaService from "../../../task/services/sla.service.js";
import priorityEngineService from "../../../task/services/priority-engine.service.js";

const taskStatusEnum = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "BLOCKED",
  "DONE",
];
const taskPriorityEnum = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

// --- READ TOOLS ---

toolRegistry.register({
  name: "task:get",
  description:
    "Get full details of a single task by ID including SLA state, priority scores, subtasks, assignee, and permissions. Returns not_found if the task does not belong to the authenticated user's accessible scope.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { taskId } = input as { taskId: string };
    const tasks = await taskService.fetchTasks(userId);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      const err = new Error("Task not found");
      (err as any).status = 404;
      throw err;
    }
    return task;
  },
});

toolRegistry.register({
  name: "task:search",
  description:
    "Search tasks accessible to the authenticated user. Supports filtering by date, status, priority, assignee, and free-text search. Returns paginated results (max 50).",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: { type: "string" },
      search: { type: "string" },
      assigneeId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const {
      date,
      search,
      assigneeId,
      limit = 50,
    } = input as {
      date?: string;
      search?: string;
      assigneeId?: string;
      limit?: number;
    };
    const tasks = await taskService.fetchTasks(
      userId,
      date,
      assigneeId,
      search,
    );
    return { tasks: tasks.slice(0, limit), total: tasks.length };
  },
});

toolRegistry.register({
  name: "task:list_mine",
  description:
    "List all tasks currently assigned to the authenticated user across all projects. Useful for understanding personal workload.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", minimum: 1, maximum: 100 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { limit = 50 } = input as { limit?: number };
    const tasks = await taskService.getTasksAssignedToMe(userId);
    return { tasks: tasks.slice(0, limit), total: tasks.length };
  },
});

toolRegistry.register({
  name: "task:summary",
  description:
    "Get a count summary of tasks by status (backlog, todo, in_progress, in_review, blocked, done, rolledOver) for a given date or overall.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { date } = input as { date?: string };
    return taskService.getSummary(userId, date);
  },
});

toolRegistry.register({
  name: "task:list_overdue",
  description:
    "List tasks that are past their scheduled date and not yet completed. Includes priority and SLA breach information.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { limit = 20 } = input as { limit?: number };
    const today = new Date().toISOString().split("T")[0];
    const tasks = await taskService.fetchTasks(userId);
    const overdue = tasks
      .filter(
        (t) =>
          t.date &&
          t.date < today &&
          t.status !== "DONE" &&
          t.status !== "rolled_over",
      )
      .slice(0, limit);
    return { tasks: overdue, total: overdue.length };
  },
});

toolRegistry.register({
  name: "task:list_blocked",
  description:
    "List all blocked tasks accessible to the authenticated user. Includes the blocking task ID where available.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      projectId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { limit = 20 } = input as { limit?: number };
    const tasks = await taskService.fetchTasks(userId);
    const blocked = tasks
      .filter((t) => t.isBlocked || t.status === "BLOCKED")
      .slice(0, limit);
    return { tasks: blocked, total: blocked.length };
  },
});

toolRegistry.register({
  name: "task:list_high_priority",
  description:
    "List open tasks with HIGH or CRITICAL dynamic priority, sorted by priority score descending. Use to identify the most important work.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { limit = 20 } = input as { limit?: number };
    const tasks = await taskService.fetchTasks(userId);
    const high = tasks
      .filter(
        (t) =>
          (t.dynamicPriority === "HIGH" || t.dynamicPriority === "CRITICAL") &&
          t.status !== "DONE" &&
          t.status !== "rolled_over",
      )
      .sort((a, b) => b.dynamicPriorityScore - a.dynamicPriorityScore)
      .slice(0, limit);
    return { tasks: high, total: high.length };
  },
});

toolRegistry.register({
  name: "task:get_context",
  description:
    "Get rich context for a single task: full task details, current SLA state, priority evaluation with reason, and blocking task info if applicable. Designed for AI context gathering.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { taskId } = input as { taskId: string };
    const tasks = await taskService.fetchTasks(userId);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      const err = new Error("Task not found");
      (err as any).status = 404;
      throw err;
    }

    const [slaStatus, priorityEval] = await Promise.all([
      slaService.getTaskStatus(taskId, userId).catch(() => null),
      priorityEngineService
        .evaluateTaskForUser(taskId, userId)
        .catch(() => null),
    ]);

    let blockingTask = null;
    if (task.blockedByTaskId) {
      const all = await taskService.fetchTasks(userId);
      blockingTask = all.find((t) => t.id === task.blockedByTaskId) ?? null;
    }

    return { task, slaStatus, priorityEval, blockingTask };
  },
});

// --- WRITE TOOLS ---

toolRegistry.register({
  name: "task:create",
  description:
    "Create a new task for the authenticated user. Applies SLA fields, priority engine, and analytics tracking. Requires a title. Optional: dueDate as date (YYYY-MM-DD; leave it out for no due date), description, priority, status, projectId, epicId, subtasks, assignedTo.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 500 },
      description: { type: "string", maxLength: 5000 },
      note: { type: "string" },
      date: { type: "string" },
      priority: { type: "string", enum: taskPriorityEnum },
      status: { type: "string", enum: taskStatusEnum },
      projectId: { type: "string" },
      epicId: { type: "string" },
      assignedTo: { type: "string" },
      subtasks: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            note: { type: "string" },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE"] },
          },
        },
      },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const payload = input as any;
    return taskService.createTask({
      ...payload,
      userId,
      source: "mcp",
    });
  },
});

toolRegistry.register({
  name: "task:update",
  description:
    "Update fields of an existing task. Enforces existing permission model: only task owners/admins can edit core fields; assignees can update status, notes, subtasks. Business rules (SLA, priority, status reconciliation) are applied.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 500 },
      description: { type: "string", maxLength: 5000 },
      note: { type: "string" },
      date: { type: "string" },
      priority: { type: "string", enum: taskPriorityEnum },
      status: { type: "string", enum: taskStatusEnum },
      projectId: { type: "string" },
      epicId: { type: "string" },
      subtasks: { type: "array", maxItems: 50, items: { type: "object" } },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const { taskId, ...updates } = input as {
      taskId: string;
      [key: string]: unknown;
    };
    return taskService.updateTask(taskId, userId, updates as any);
  },
});

toolRegistry.register({
  name: "task:complete",
  description:
    "Mark a task as DONE. Applies SLA completion tracking, closes subtasks, and records analytics. Fails if the task is currently blocked.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const { taskId } = input as { taskId: string };
    return taskService.updateTask(taskId, userId, { status: "DONE" });
  },
});

toolRegistry.register({
  name: "task:assign",
  description:
    "Assign a task to another user. Target user must be a member of the task's project. Sends a real-time notification to the target user.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "userId"],
    properties: {
      taskId: { type: "string" },
      userId: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "sensitive_write",
  handler: async (actorUserId, input) => {
    const { taskId, userId: targetUserId } = input as {
      taskId: string;
      userId: string;
    };
    return taskService.assignTask(taskId, actorUserId, {
      userId: targetUserId,
    });
  },
});

toolRegistry.register({
  name: "task:block",
  description:
    "Mark a task as blocked, optionally specifying which task is blocking it. Pauses SLA timers and records analytics.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
      blockedByTaskId: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const { taskId, blockedByTaskId } = input as {
      taskId: string;
      blockedByTaskId?: string;
    };
    return taskService.markTaskBlocked(taskId, userId, blockedByTaskId);
  },
});

toolRegistry.register({
  name: "task:unblock",
  description:
    "Remove the blocked state from a task and transition it back to TODO. Resumes SLA timers and adjusts SLA deadlines for time paused.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "write",
  handler: async (userId, input) => {
    const { taskId } = input as { taskId: string };
    return taskService.unblockTask(taskId, userId);
  },
});

// --- DESTRUCTIVE TOOLS ---

toolRegistry.register({
  name: "task:delete",
  description:
    "Permanently delete a task. This is irreversible. Requires confirmation token. Only task owners and project admins can delete tasks.",
  domain: "task",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
      _confirmationToken: { type: "string" },
    },
  },
  requiredScope: "work:write",
  risk: "destructive",
  requiresConfirmation: true,
  handler: async (userId, input) => {
    const { taskId } = input as { taskId: string };
    await taskService.deleteTask(taskId, userId);
    return { deleted: true, taskId };
  },
});
