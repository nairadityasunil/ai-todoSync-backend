/**
 * Collaboration domain MCP tools: chat messages, notes, and comments.
 */

import toolRegistry from "../../registry/tool-registry.js";
import chatService from "../../../chat/services/chat.service.js";
import noteService from "../../../note/services/note.service.js";
import commentService from "../../../comment/services/comment.service.js";
import projectService from "../../../project/services/project.service.js";

// --- READ TOOLS ---

toolRegistry.register({
  name: "collab:search_messages",
  description:
    "Search chat messages in a project by keyword. Returns up to 20 matching messages with sender info and context.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "query"],
    properties: {
      projectId: { type: "string" },
      query: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "number", minimum: 1, maximum: 20 },
    },
  },
  requiredScope: "collaboration:read",
  risk: "read",
  handler: async (userId, input) => {
    const {
      projectId,
      query,
      limit = 20,
    } = input as {
      projectId: string;
      query: string;
      limit?: number;
    };
    await projectService.assertProjectMembership(userId, projectId);
    return chatService.searchMessages(projectId, query, { limit });
  },
});

toolRegistry.register({
  name: "collab:get_thread",
  description: "Get all replies in a chat message thread.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "messageId"],
    properties: {
      projectId: { type: "string" },
      messageId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
  requiredScope: "collaboration:read",
  risk: "read",
  handler: async (_userId, input) => {
    const {
      projectId,
      messageId,
      limit = 20,
    } = input as {
      projectId: string;
      messageId: string;
      limit?: number;
    };
    return chatService.getThreadReplies(projectId, messageId, { limit });
  },
});

toolRegistry.register({
  name: "collab:list_notes",
  description:
    "List notes associated with a project. Returns note titles, content, and metadata.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" },
    },
  },
  requiredScope: "collaboration:read",
  risk: "read",
  handler: async (userId, input) => {
    const { projectId } = input as { projectId: string };
    await projectService.assertProjectMembership(userId, projectId);
    const notes = await noteService.fetchProjectNotes(userId, projectId);
    return { notes };
  },
});

toolRegistry.register({
  name: "collab:get_note",
  description: "Get the full content of a single note by ID.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["noteId"],
    properties: {
      noteId: { type: "string" },
    },
  },
  requiredScope: "collaboration:read",
  risk: "read",
  handler: async (userId, input) => {
    const { noteId } = input as { noteId: string };
    return noteService.fetchNote(userId, noteId);
  },
});

toolRegistry.register({
  name: "collab:list_comments",
  description: "List all comments on a task.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
    },
  },
  requiredScope: "collaboration:read",
  risk: "read",
  handler: async (userId, input) => {
    const { taskId } = input as { taskId: string };
    const comments = await commentService.getComments(taskId, userId);
    return { comments };
  },
});

// --- WRITE TOOLS ---

toolRegistry.register({
  name: "collab:add_comment",
  description: "Add a comment to a task as the authenticated user.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "content"],
    properties: {
      taskId: { type: "string" },
      content: { type: "string", minLength: 1, maxLength: 5000 },
    },
  },
  requiredScope: "collaboration:write",
  risk: "write",
  handler: async (userId, input) => {
    const { taskId, content } = input as {
      taskId: string;
      content: string;
    };
    return commentService.addComment(taskId, userId, content);
  },
});

toolRegistry.register({
  name: "collab:create_note",
  description:
    "Create a new note in a project. Notes support markdown content.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "title", "content"],
    properties: {
      projectId: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 300 },
      content: { type: "string", maxLength: 50000 },
    },
  },
  requiredScope: "collaboration:write",
  risk: "write",
  handler: async (userId, input) => {
    const { projectId, title, content } = input as {
      projectId: string;
      title: string;
      content: string;
    };
    return noteService.createNote(userId, projectId, { title, content });
  },
});

// --- SENSITIVE WRITE TOOLS ---

toolRegistry.register({
  name: "collab:create_task_from_message",
  description:
    "Create a task directly from a chat message. The message content becomes the task description. Confirmation required. Posts a system acknowledgment message in the project chat.",
  domain: "collaboration",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["messageId"],
    properties: {
      messageId: { type: "string" },
      title: { type: "string", maxLength: 500 },
      priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
      _confirmationToken: { type: "string" },
    },
  },
  requiredScope: "collaboration:write",
  risk: "sensitive_write",
  requiresConfirmation: true,
  handler: async (userId, input) => {
    const { messageId, title, priority } = input as {
      messageId: string;
      title?: string;
      priority?: string;
    };
    return chatService.createTaskFromMessage(userId, messageId, {
      title,
      priority,
    });
  },
});
