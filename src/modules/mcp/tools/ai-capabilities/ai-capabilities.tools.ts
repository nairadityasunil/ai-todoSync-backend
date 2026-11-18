/**
 * AI Capabilities domain MCP tools.
 * Exposes existing AI services through MCP. Does NOT duplicate AI logic.
 */

import toolRegistry from "../../registry/tool-registry.js";
import aiService from "../../../ai/services/ai/ai.service.js";
import taskService from "../../../task/services/task.service.js";

toolRegistry.register({
  name: "ai:plan_daily_work",
  description:
    "Use the AI planning service to generate a prioritized daily schedule for the authenticated user's current tasks. Returns time blocks with task assignments and focus notes.",
  domain: "ai-capabilities",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: { type: "string" },
      workloadContext: { type: "string", maxLength: 1000 },
      userApiKey: { type: "string" },
    },
  },
  requiredScope: "ai:execute",
  risk: "write",
  handler: async (userId, input) => {
    const { date, workloadContext, userApiKey } = input as {
      date?: string;
      workloadContext?: string;
      userApiKey?: string;
    };
    const tasks = await taskService.fetchTasks(userId, date);
    const openTasks = tasks
      .filter((t) => t.status !== "DONE" && t.status !== "rolled_over")
      .slice(0, 30)
      .map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.dynamicPriority,
        dueDate: t.date ?? undefined,
        isBlocked: t.isBlocked,
      }));

    return aiService.planDailyWork(openTasks, workloadContext, userApiKey);
  },
});

toolRegistry.register({
  name: "ai:decompose_task",
  description:
    "Use AI to decompose a high-level task into subtasks. Returns a structured breakdown with subtask titles, descriptions, and time estimates.",
  domain: "ai-capabilities",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskTitle"],
    properties: {
      taskTitle: { type: "string", minLength: 1, maxLength: 500 },
      taskDescription: { type: "string", maxLength: 5000 },
      projectContext: { type: "string", maxLength: 2000 },
      userApiKey: { type: "string" },
    },
  },
  requiredScope: "ai:execute",
  risk: "write",
  handler: async (_userId, input) => {
    const { taskTitle, taskDescription, projectContext, userApiKey } =
      input as {
        taskTitle: string;
        taskDescription?: string;
        projectContext?: string;
        userApiKey?: string;
      };
    return aiService.decomposeTask(
      taskTitle,
      taskDescription,
      projectContext,
      userApiKey,
    );
  },
});

toolRegistry.register({
  name: "ai:generate_document",
  description:
    "Generate a technical or product document (PRD, architecture doc, test plan, etc.) using AI. Returns a markdown document with title, content, and tags.",
  domain: "ai-capabilities",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["docType", "title", "projectContext"],
    properties: {
      docType: { type: "string", maxLength: 100 },
      title: { type: "string", minLength: 1, maxLength: 500 },
      projectContext: { type: "string", minLength: 1, maxLength: 10000 },
      userApiKey: { type: "string" },
    },
  },
  requiredScope: "ai:execute",
  risk: "write",
  handler: async (_userId, input) => {
    const { docType, title, projectContext, userApiKey } = input as {
      docType: string;
      title: string;
      projectContext: string;
      userApiKey?: string;
    };
    return aiService.generateDocument(
      docType,
      title,
      projectContext,
      userApiKey,
    );
  },
});

toolRegistry.register({
  name: "ai:generate_notes",
  description:
    "Process raw meeting notes or a transcript into structured output: summary, key decisions, action items, open questions, and formatted markdown.",
  domain: "ai-capabilities",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["rawNotes"],
    properties: {
      rawNotes: { type: "string", minLength: 1, maxLength: 20000 },
      projectContext: { type: "string", maxLength: 2000 },
      userApiKey: { type: "string" },
    },
  },
  requiredScope: "ai:execute",
  risk: "write",
  handler: async (_userId, input) => {
    const { rawNotes, projectContext, userApiKey } = input as {
      rawNotes: string;
      projectContext?: string;
      userApiKey?: string;
    };
    return aiService.generateMeetingNotes(rawNotes, projectContext, userApiKey);
  },
});
