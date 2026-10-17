import type { Server as HTTPServer } from "http";
import { Server, type Socket } from "socket.io";
import jwt from "jsonwebtoken";

import UserModel, {
  type IUserDocument,
} from "../modules/auth/models/user.model.js";
import ProjectMemberModel from "../modules/project/models/project-member.model.js";
import authService from "../modules/auth/services/auth.service.js";
import chatService from "../modules/chat/services/chat.service.js";
import env from "../config/env.js";
import logger from "../lib/logger.js";
import {
  resolveProjectObjectId,
  resolveProjectUuid,
} from "../utils/project-id.js";

/**
 * Socket.IO events for real-time chat
 */
export enum ChatSocketEvents {
  // Connection events
  CONNECTION = "connection",
  DISCONNECT = "disconnect",

  // Room events
  JOIN_PROJECT = "project:join",
  LEAVE_PROJECT = "project:leave",
  JOIN_WORKSPACE = "workspace:join",
  LEAVE_WORKSPACE = "workspace:leave",

  // Message events
  MESSAGE_SEND = "message:send",
  MESSAGE_RECEIVE = "message:receive",
  MESSAGE_EDIT = "message:edit",
  MESSAGE_DELETE = "message:delete",
  MESSAGE_READ = "message:read",

  // Thread events
  THREAD_OPEN = "thread:open",
  THREAD_CLOSE = "thread:close",
  THREAD_REPLY = "thread:reply",

  // Reaction events
  REACTION_ADD = "reaction:add",
  REACTION_REMOVE = "reaction:remove",

  // Typing events
  TYPING_START = "typing:start",
  TYPING_STOP = "typing:stop",
  TYPING_UPDATE = "typing:update",

  // Presence events
  PRESENCE_JOIN = "presence:join",
  PRESENCE_LEAVE = "presence:leave",
  PRESENCE_UPDATE = "presence:update",
}

interface AuthenticatedSocket extends Socket {
  user?: IUserDocument;
  currentProjectId?: string;
}

interface MessagePayload {
  projectId?: string;
  workspaceId?: string;
  recipientId?: string;
  content: string;
  replyToId?: string;
  mentions?: string[];
  clientMessageId?: string;
}

interface EditMessagePayload {
  projectId: string;
  messageId: string;
  content: string;
}

interface DeleteMessagePayload {
  projectId: string;
  messageId: string;
}

interface ReactionPayload {
  projectId: string;
  messageId: string;
  emoji: string;
}

interface TypingPayload {
  projectId?: string;
  workspaceId?: string;
  recipientId?: string;
}

interface JoinProjectPayload {
  projectId: string;
}

interface ThreadPayload {
  projectId: string;
  messageId: string;
}

interface MarkReadPayload {
  projectId: string;
  messageIds?: string[];
}

class ChatSocketServer {
  private io: Server | null = null;
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> Set of socket IDs

  public initialize(server: HTTPServer): void {
    const allowedOrigins = [
      env.FRONTEND_BASE_URL,
      ...(env.ALLOWED_ORIGINS || []),
    ].map((o) => o.replace(/\/$/, ""));

    this.io = new Server(server, {
      cors: {
        origin: (requestOrigin, callback) => {
          if (
            !requestOrigin ||
            allowedOrigins.includes(requestOrigin.replace(/\/$/, ""))
          ) {
            callback(null, true);
          } else {
            callback(null, true); // Allow dev origins gracefully
          }
        },
        credentials: true,
        methods: ["GET", "POST"],
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    this.io.use(this.authenticateSocket.bind(this));
    this.io.on(ChatSocketEvents.CONNECTION, this.handleConnection.bind(this));

    logger.info("Socket.IO server initialized");
  }

  /**
   * Authenticate socket connections using JWT
   */
  private async authenticateSocket(
    socket: AuthenticatedSocket,
    next: (err?: Error) => void,
  ): Promise<void> {
    try {
      const token = this.extractToken(socket);

      if (!token) {
        return next(new Error("Authentication required"));
      }

      let user: IUserDocument | null = null;

      try {
        const decoded = authService.verifyAccessToken(token);
        if (decoded?.userId) {
          user = await UserModel.findById(decoded.userId);
        }
      } catch {
        // Fall back to direct JWT verification
        try {
          const decoded = jwt.verify(token, env.JWT_SECRET) as {
            userId: string;
          };
          if (decoded?.userId) {
            user = await UserModel.findById(decoded.userId);
          }
        } catch {
          // Fall back to Sync API key verification
          const { findUserBySyncApiKey } =
            await import("../modules/auth/repositories/auth.repository.js");
          user = await findUserBySyncApiKey(token);
        }
      }

      if (!user) {
        return next(new Error("User not found"));
      }

      socket.user = user;
      next();
    } catch (error) {
      logger.error("Socket authentication failed", error as Error);
      next(new Error("Authentication failed"));
    }
  }

  /**
   * Extract JWT token from socket handshake
   */
  private extractToken(socket: AuthenticatedSocket): string | null {
    let rawToken: string | null = null;

    // Try auth token first
    if (socket.handshake.auth?.token) {
      rawToken = socket.handshake.auth.token as string;
    } else if (socket.handshake.headers?.authorization) {
      rawToken = socket.handshake.headers.authorization;
    } else if (socket.handshake.query?.token) {
      const token = socket.handshake.query.token;
      rawToken = Array.isArray(token) ? token[0] : token;
    } else if (socket.handshake.headers.cookie) {
      const match = socket.handshake.headers.cookie.match(/token=([^;]+)/);
      if (match) {
        rawToken = match[1];
      }
    }

    if (rawToken) {
      return rawToken.replace(/^Bearer\s+/i, "").trim();
    }

    return null;
  }

  /**
   * Handle new socket connections
   */
  private handleConnection(socket: AuthenticatedSocket): void {
    const userId = socket.user!._id.toString();
    logger.info(`Socket connected: ${socket.id} (User: ${userId})`);

    // Track user sockets for multi-device support
    this.addUserSocket(userId, socket.id);

    // Join personal room for direct notifications
    socket.join(`user:${userId}`);

    // Setup event handlers
    this.setupEventHandlers(socket);

    // Handle disconnect
    socket.on(ChatSocketEvents.DISCONNECT, () => {
      logger.info(`Socket disconnected: ${socket.id} (User: ${userId})`);
      this.removeUserSocket(userId, socket.id);
      this.handleLeaveProject(socket);
    });
  }

  /**
   * Setup all socket event handlers
   */
  private setupEventHandlers(socket: AuthenticatedSocket): void {
    // Project room management
    socket.on(
      ChatSocketEvents.JOIN_PROJECT,
      (payload: JoinProjectPayload, callback?: (resp: any) => void) =>
        this.handleJoinProject(socket, payload, callback),
    );
    socket.on(
      ChatSocketEvents.LEAVE_PROJECT,
      (callback?: (resp: any) => void) =>
        this.handleLeaveProject(socket, callback),
    );

    // Workspace room management
    socket.on(
      ChatSocketEvents.JOIN_WORKSPACE,
      (payload: { workspaceId: string }, callback?: (resp: any) => void) =>
        this.handleJoinWorkspace(socket, payload, callback),
    );
    socket.on(
      ChatSocketEvents.LEAVE_WORKSPACE,
      (payload: { workspaceId: string }, callback?: (resp: any) => void) =>
        this.handleLeaveWorkspace(socket, payload, callback),
    );

    // Message events
    socket.on(ChatSocketEvents.MESSAGE_SEND, (payload: MessagePayload) =>
      this.handleSendMessage(socket, payload),
    );
    socket.on(ChatSocketEvents.MESSAGE_EDIT, (payload: EditMessagePayload) =>
      this.handleEditMessage(socket, payload),
    );
    socket.on(
      ChatSocketEvents.MESSAGE_DELETE,
      (payload: DeleteMessagePayload) =>
        this.handleDeleteMessage(socket, payload),
    );
    socket.on(ChatSocketEvents.MESSAGE_READ, (payload: MarkReadPayload) =>
      this.handleMarkRead(socket, payload),
    );

    // Thread events
    socket.on(ChatSocketEvents.THREAD_OPEN, (payload: ThreadPayload) =>
      this.handleThreadOpen(socket, payload),
    );
    socket.on(ChatSocketEvents.THREAD_CLOSE, () =>
      this.handleThreadClose(socket),
    );

    // Reaction events
    socket.on(ChatSocketEvents.REACTION_ADD, (payload: ReactionPayload) =>
      this.handleAddReaction(socket, payload),
    );
    socket.on(ChatSocketEvents.REACTION_REMOVE, (payload: ReactionPayload) =>
      this.handleRemoveReaction(socket, payload),
    );

    // Typing events
    socket.on(ChatSocketEvents.TYPING_START, (payload: TypingPayload) =>
      this.handleTypingStart(socket, payload),
    );
    socket.on(ChatSocketEvents.TYPING_STOP, (payload: TypingPayload) =>
      this.handleTypingStop(socket, payload),
    );
  }

  /**
   * Handle joining a project room
   */
  private async handleJoinProject(
    socket: AuthenticatedSocket,
    payload: JoinProjectPayload,
    callback?: (resp: any) => void,
  ): Promise<void> {
    try {
      const { projectId } = payload;
      const userId = socket.user!._id.toString();

      const resolvedProjectId =
        (await resolveProjectObjectId(projectId)) || projectId;
      const projectUuid = (await resolveProjectUuid(projectId)) || projectId;

      // Verify project membership
      const membership = await ProjectMemberModel.findOne({
        projectId: resolvedProjectId,
        userId,
      });

      if (!membership) {
        socket.emit("error", { message: "Not a project member" });
        return;
      }

      // Leave previous project room if any
      if (socket.currentProjectId) {
        socket.leave(`project:${socket.currentProjectId}`);
      }

      // Join rooms for both representations so events are received regardless of format
      socket.join(`project:${projectId}`);
      socket.join(`project:${resolvedProjectId}`);
      socket.join(`project:${projectUuid}`);
      socket.currentProjectId = projectUuid;

      // Broadcast user joined
      socket
        .to(`project:${projectUuid}`)
        .to(`project:${resolvedProjectId}`)
        .emit(ChatSocketEvents.PRESENCE_JOIN, {
          userId,
          timestamp: new Date().toISOString(),
        });

      // Get unread count
      const unreadCount = await chatService.getUnreadCount(
        resolvedProjectId,
        userId,
      );

      const response = {
        success: true,
        projectId: projectUuid,
        unreadCount,
      };

      if (callback) {
        callback(response);
      } else {
        socket.emit(ChatSocketEvents.JOIN_PROJECT, response);
      }
    } catch (error) {
      logger.error("Error joining project", error as Error);
      const errorResp = { success: false, message: "Failed to join project" };
      if (callback) {
        callback(errorResp);
      } else {
        socket.emit("error", errorResp);
      }
    }
  }

  /**
   * Handle leaving a project room
   */
  private handleLeaveProject(
    socket: AuthenticatedSocket,
    callback?: (resp: any) => void,
  ): void {
    if (socket.currentProjectId) {
      const userId = socket.user!._id.toString();

      socket.leave(`project:${socket.currentProjectId}`);
      socket
        .to(`project:${socket.currentProjectId}`)
        .emit(ChatSocketEvents.PRESENCE_LEAVE, {
          userId,
          timestamp: new Date().toISOString(),
        });

      socket.currentProjectId = undefined;
    }

    if (callback) {
      callback({ success: true });
    }
  }

  /**
   * Handle joining a workspace room
   */
  private async handleJoinWorkspace(
    socket: AuthenticatedSocket,
    payload: { workspaceId: string },
    callback?: (resp: any) => void,
  ): Promise<void> {
    try {
      const { workspaceId } = payload;
      const userId = socket.user!._id.toString();

      const WorkspaceMemberModel = (
        await import("../modules/workspace/models/workspace-member.model.js")
      ).default;
      const membership = await WorkspaceMemberModel.findOne({
        workspaceId,
        userId,
      });

      if (!membership) {
        socket.emit("error", { message: "Not a workspace member" });
        return;
      }

      socket.join(`workspace:${workspaceId}`);

      const response = { success: true, workspaceId };
      if (callback) {
        callback(response);
      } else {
        socket.emit(ChatSocketEvents.JOIN_WORKSPACE, response);
      }
    } catch (error) {
      logger.error("Error joining workspace chat", error as Error);
      const errResp = { success: false, message: "Failed to join workspace" };
      if (callback) callback(errResp);
    }
  }

  /**
   * Handle leaving a workspace room
   */
  private handleLeaveWorkspace(
    socket: AuthenticatedSocket,
    payload: { workspaceId: string },
    callback?: (resp: any) => void,
  ): void {
    if (payload?.workspaceId) {
      socket.leave(`workspace:${payload.workspaceId}`);
    }
    if (callback) {
      callback({ success: true });
    }
  }

  /**
   * Handle sending a message
   */
  private async handleSendMessage(
    socket: AuthenticatedSocket,
    payload: MessagePayload,
  ): Promise<void> {
    try {
      const userId = socket.user!._id.toString();

      // Workspace-level message (common lounge or direct message)
      if (payload.workspaceId) {
        const { workspaceId, recipientId, content, replyToId, mentions } =
          payload;
        const WorkspaceMemberModel = (
          await import("../modules/workspace/models/workspace-member.model.js")
        ).default;
        const membership = await WorkspaceMemberModel.findOne({
          workspaceId,
          userId,
        });

        if (!membership) {
          socket.emit("error", { message: "Not a workspace member" });
          return;
        }

        const message = await chatService.sendWorkspaceMessage(
          workspaceId,
          userId,
          content,
          { recipientId, replyToId, mentions },
        );

        if (payload.clientMessageId) {
          (message as any).clientMessageId = payload.clientMessageId;
        }

        if (recipientId) {
          // Direct 1-on-1 message: emit to recipient's personal room & sender's room
          this.io!.to(`user:${recipientId}`)
            .to(`user:${userId}`)
            .emit(ChatSocketEvents.MESSAGE_RECEIVE, {
              message,
              clientMessageId: payload.clientMessageId,
            });
        } else {
          // Workspace common lounge
          this.io!.to(`workspace:${workspaceId}`).emit(
            ChatSocketEvents.MESSAGE_RECEIVE,
            { message, clientMessageId: payload.clientMessageId },
          );
        }

        socket.emit(ChatSocketEvents.MESSAGE_SEND, {
          success: true,
          message,
          clientMessageId: payload.clientMessageId,
        });
        return;
      }

      // Project-level message
      const { projectId, content, replyToId, mentions } = payload;
      if (!projectId) {
        socket.emit("error", {
          message: "Project ID or Workspace ID is required",
        });
        return;
      }

      const resolvedProjectId =
        (await resolveProjectObjectId(projectId)) || projectId;
      const projectUuid = (await resolveProjectUuid(projectId)) || projectId;

      // Verify user is in the project room or auto-join if member
      if (
        socket.currentProjectId !== projectUuid &&
        socket.currentProjectId !== resolvedProjectId
      ) {
        const membership = await ProjectMemberModel.findOne({
          projectId: resolvedProjectId,
          userId,
        });
        if (!membership) {
          socket.emit("error", { message: "Not a project member" });
          return;
        }
        socket.join(`project:${projectId}`);
        socket.join(`project:${resolvedProjectId}`);
        socket.join(`project:${projectUuid}`);
        socket.currentProjectId = projectUuid;
      }

      const message = await chatService.sendMessage(
        resolvedProjectId,
        userId,
        content,
        { replyToId, mentions },
      );

      // Ensure message.projectId sent to socket is projectUuid!
      if (!message.projectId || message.projectId === resolvedProjectId) {
        message.projectId = projectUuid;
      }

      if (payload.clientMessageId) {
        (message as any).clientMessageId = payload.clientMessageId;
      }

      // Broadcast to all project members
      this.io!.to(`project:${projectId}`)
        .to(`project:${resolvedProjectId}`)
        .to(`project:${projectUuid}`)
        .emit(ChatSocketEvents.MESSAGE_RECEIVE, {
          message,
          clientMessageId: payload.clientMessageId,
        });

      // Also emit to sender for confirmation
      socket.emit(ChatSocketEvents.MESSAGE_SEND, {
        success: true,
        message,
        clientMessageId: payload.clientMessageId,
      });
    } catch (error) {
      logger.error("Error sending message", error as Error);
      socket.emit("error", {
        message: (error as Error).message || "Failed to send message",
      });
    }
  }

  /**
   * Handle editing a message
   */
  private async handleEditMessage(
    socket: AuthenticatedSocket,
    payload: EditMessagePayload,
  ): Promise<void> {
    try {
      const { projectId, messageId, content } = payload;
      const userId = socket.user!._id.toString();

      const message = await chatService.editMessage(
        projectId,
        messageId,
        userId,
        content,
      );

      // Broadcast update to project
      this.io!.to(`project:${projectId}`).emit(ChatSocketEvents.MESSAGE_EDIT, {
        message,
      });
    } catch (error) {
      logger.error("Error editing message", error as Error);
      socket.emit("error", {
        message: (error as Error).message || "Failed to edit message",
      });
    }
  }

  /**
   * Handle deleting a message
   */
  private async handleDeleteMessage(
    socket: AuthenticatedSocket,
    payload: DeleteMessagePayload,
  ): Promise<void> {
    try {
      const { projectId, messageId } = payload;
      const userId = socket.user!._id.toString();

      // Check if user is project admin
      const membership = await ProjectMemberModel.findOne({
        projectId,
        userId,
      });
      const isAdmin = membership?.role === "ADMIN";

      await chatService.deleteMessage(projectId, messageId, userId, isAdmin);

      // Broadcast deletion to project
      this.io!.to(`project:${projectId}`).emit(
        ChatSocketEvents.MESSAGE_DELETE,
        {
          messageId,
          deletedBy: userId,
        },
      );
    } catch (error) {
      logger.error("Error deleting message", error as Error);
      socket.emit("error", {
        message: (error as Error).message || "Failed to delete message",
      });
    }
  }

  /**
   * Handle marking messages as read
   */
  private async handleMarkRead(
    socket: AuthenticatedSocket,
    payload: MarkReadPayload,
  ): Promise<void> {
    try {
      const { projectId, messageIds } = payload;
      const userId = socket.user!._id.toString();

      await chatService.markMessagesAsRead(projectId, userId, messageIds);

      // Notify other users that messages were read
      socket.to(`project:${projectId}`).emit(ChatSocketEvents.MESSAGE_READ, {
        userId,
        messageIds,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Error marking messages read", error as Error);
    }
  }

  /**
   * Handle opening a thread
   */
  private handleThreadOpen(
    socket: AuthenticatedSocket,
    payload: ThreadPayload,
  ): void {
    const { messageId } = payload;
    socket.join(`thread:${messageId}`);
  }

  /**
   * Handle closing a thread
   */
  private handleThreadClose(socket: AuthenticatedSocket): void {
    // Leave all thread rooms
    for (const room of socket.rooms) {
      if (room.startsWith("thread:")) {
        socket.leave(room);
      }
    }
  }

  /**
   * Handle adding a reaction
   */
  private async handleAddReaction(
    socket: AuthenticatedSocket,
    payload: ReactionPayload,
  ): Promise<void> {
    try {
      const { projectId, messageId, emoji } = payload;
      const userId = socket.user!._id.toString();

      const message = await chatService.addReaction(
        projectId,
        messageId,
        userId,
        emoji,
      );

      // Broadcast reaction
      this.io!.to(`project:${projectId}`).emit(ChatSocketEvents.REACTION_ADD, {
        messageId,
        userId,
        emoji,
        reactions: message.reactions,
      });
    } catch (error) {
      logger.error("Error adding reaction", error as Error);
      socket.emit("error", { message: "Failed to add reaction" });
    }
  }

  /**
   * Handle removing a reaction
   */
  private async handleRemoveReaction(
    socket: AuthenticatedSocket,
    payload: ReactionPayload,
  ): Promise<void> {
    try {
      const { projectId, messageId, emoji } = payload;
      const userId = socket.user!._id.toString();

      const message = await chatService.removeReaction(
        projectId,
        messageId,
        userId,
        emoji,
      );

      // Broadcast reaction removal
      this.io!.to(`project:${projectId}`).emit(
        ChatSocketEvents.REACTION_REMOVE,
        {
          messageId,
          userId,
          emoji,
          reactions: message.reactions,
        },
      );
    } catch (error) {
      logger.error("Error removing reaction", error as Error);
      socket.emit("error", { message: "Failed to remove reaction" });
    }
  }

  /**
   * Handle typing start
   */
  private async handleTypingStart(
    socket: AuthenticatedSocket,
    payload: TypingPayload,
  ): Promise<void> {
    const { projectId, workspaceId, recipientId } = payload;
    const userId = socket.user!._id.toString();
    const user = socket.user!;

    if (projectId) {
      const resolvedProjectId =
        (await resolveProjectObjectId(projectId)) || projectId;
      const projectUuid = (await resolveProjectUuid(projectId)) || projectId;
      socket
        .to(`project:${projectUuid}`)
        .to(`project:${resolvedProjectId}`)
        .to(`project:${projectId}`)
        .emit(ChatSocketEvents.TYPING_UPDATE, {
          projectId: projectUuid,
          userId,
          userName: user.name || user.email,
          isTyping: true,
        });
    } else if (recipientId) {
      this.io?.to(`user:${recipientId}`).emit(ChatSocketEvents.TYPING_UPDATE, {
        workspaceId,
        recipientId,
        userId,
        userName: user.name || user.email,
        isTyping: true,
      });
    } else if (workspaceId) {
      socket
        .to(`workspace:${workspaceId}`)
        .emit(ChatSocketEvents.TYPING_UPDATE, {
          workspaceId,
          userId,
          userName: user.name || user.email,
          isTyping: true,
        });
    }
  }

  /**
   * Handle typing stop
   */
  private async handleTypingStop(
    socket: AuthenticatedSocket,
    payload: TypingPayload,
  ): Promise<void> {
    const { projectId, workspaceId, recipientId } = payload;
    const userId = socket.user!._id.toString();

    if (projectId) {
      const resolvedProjectId =
        (await resolveProjectObjectId(projectId)) || projectId;
      const projectUuid = (await resolveProjectUuid(projectId)) || projectId;
      socket
        .to(`project:${projectUuid}`)
        .to(`project:${resolvedProjectId}`)
        .to(`project:${projectId}`)
        .emit(ChatSocketEvents.TYPING_UPDATE, {
          projectId: projectUuid,
          userId,
          isTyping: false,
        });
    } else if (recipientId) {
      this.io?.to(`user:${recipientId}`).emit(ChatSocketEvents.TYPING_UPDATE, {
        workspaceId,
        recipientId,
        userId,
        isTyping: false,
      });
    } else if (workspaceId) {
      socket
        .to(`workspace:${workspaceId}`)
        .emit(ChatSocketEvents.TYPING_UPDATE, {
          workspaceId,
          userId,
          isTyping: false,
        });
    }
  }

  /**
   * Track user sockets for multi-device support
   */
  private addUserSocket(userId: string, socketId: string): void {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(socketId);
  }

  /**
   * Remove user socket tracking
   */
  private removeUserSocket(userId: string, socketId: string): void {
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  /**
   * Emit system message to a project
   */
  public async emitSystemMessage(
    projectId: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.io) return;

    try {
      const message = await chatService.sendSystemMessage(
        projectId,
        content,
        metadata,
      );
      this.io
        .to(`project:${projectId}`)
        .emit(ChatSocketEvents.MESSAGE_RECEIVE, {
          message,
        });
    } catch (error) {
      logger.error("Error emitting system message", error as Error);
    }
  }

  /**
   * Notify user of new activity
   */
  public notifyUser(userId: string, event: string, data: unknown): void {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit(event, data);
  }
}

const chatSocketServer = new ChatSocketServer();
export default chatSocketServer;
