import type { Types } from "mongoose";

import { MessageType } from "../models/chat-message.model.js";
import type { IMessageMetadata } from "../models/chat-message.model.js";
import * as chatRepository from "../repositories/chat.repository.js";
import * as projectMemberRepository from "../../project/repositories/project-member.repository.js";
import type {
  CreateMessagePayload,
  PaginationOptions,
} from "../../../modules/chat/repositories/chat.repository.js";
import {
  getCachedProjectUuid,
  resolveProjectObjectId,
  resolveProjectUuid,
} from "../../../utils/project-id.js";
import CloudinaryService from "../../../shared/services/cloudinary.service.js";
import logger from "../../../lib/logger.js";

async function processAttachmentsCloudinary(
  metadata?: IMessageMetadata,
): Promise<IMessageMetadata | undefined> {
  if (
    !metadata ||
    !metadata.attachments ||
    !Array.isArray(metadata.attachments)
  ) {
    return metadata;
  }

  const updatedAttachments = await Promise.all(
    metadata.attachments.map(async (att: any) => {
      if (att && typeof att.url === "string" && att.url.startsWith("data:")) {
        try {
          const folder = att.type?.startsWith("image/")
            ? "pristine/chat/images"
            : "pristine/chat/files";
          const uploadRes = await CloudinaryService.uploadDataUrl(
            att.url,
            folder,
          );
          return {
            ...att,
            url: uploadRes.secureUrl,
            publicId: uploadRes.publicId,
          };
        } catch (err) {
          logger.error(
            "Failed to upload attachment to Cloudinary, keeping fallback URI",
            err instanceof Error ? err : new Error(String(err)),
          );
          return att;
        }
      }
      return att;
    }),
  );

  return {
    ...metadata,
    attachments: updatedAttachments,
  };
}

interface SenderDto {
  id: string;
  email: string;
  name: string | null;
}

interface ReplyToDto {
  id: string;
  content: string;
  sender: SenderDto | null;
}

interface ReactionDto {
  userId: string;
  emoji: string;
  createdAt: Date;
}

interface MessageDto {
  id: string;
  projectId: string | null;
  workspaceId?: string | null;
  recipientId?: string | null;
  recipient?: SenderDto | null;
  senderId: string | null;
  sender: SenderDto | null;
  type: MessageType;
  content: string;
  replyToId: string | null;
  replyTo: ReplyToDto | null;
  readBy: string[];
  reactions: ReactionDto[];
  mentions?: { userId: string; mentionedBy: string }[];
  isEdited: boolean;
  isDeleted: boolean;
  metadata: IMessageMetadata;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MessageListResult {
  messages: MessageDto[];
  hasMore: boolean;
}

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class ChatService {
  private readonly MAX_CONTENT_LENGTH = 4000;
  private readonly MAX_THREAD_DEPTH = 3;

  /**
   * Send a new message
   */
  public async sendMessage(
    projectId: string,
    senderId: string,
    content: string,
    options?: {
      type?: MessageType;
      replyToId?: string;
      mentions?: string[];
      metadata?: IMessageMetadata;
    },
  ): Promise<MessageDto> {
    const trimmedContent = content?.trim() ?? "";
    const hasAttachments =
      options?.metadata?.attachments &&
      Array.isArray(options.metadata.attachments) &&
      options.metadata.attachments.length > 0;

    if ((!trimmedContent || trimmedContent.length === 0) && !hasAttachments) {
      throw new HttpError(400, "Message content or attachment is required");
    }

    const resolvedProjectId =
      (await resolveProjectObjectId(projectId)) || projectId;
    const projectUuid = (await resolveProjectUuid(projectId)) || projectId;

    // Issue #5: Validate active membership server-side
    const membership = await projectMemberRepository.getProjectMembership(
      resolvedProjectId,
      senderId,
    );
    if (membership == null) {
      throw new HttpError(403, "Only active project members can send messages");
    }

    if (trimmedContent.length > this.MAX_CONTENT_LENGTH) {
      throw new HttpError(
        400,
        `Message content exceeds maximum length of ${this.MAX_CONTENT_LENGTH} characters`,
      );
    }

    // Validate replyToId if provided
    let normalizedReplyToId: string | null = null;
    if (options?.replyToId) {
      const parentMessage = await chatRepository.getMessageByIdAndProject(
        options.replyToId,
        resolvedProjectId,
      );

      if (!parentMessage) {
        throw new HttpError(404, "Parent message not found");
      }

      // Check thread depth
      const depth = await this.calculateThreadDepth(options.replyToId);
      if (depth >= this.MAX_THREAD_DEPTH) {
        throw new HttpError(
          400,
          `Thread depth exceeds maximum of ${this.MAX_THREAD_DEPTH}`,
        );
      }

      normalizedReplyToId = options.replyToId;
    }

    const mentionsList: { userId: string; mentionedBy: string }[] = [];
    if (options?.mentions && Array.isArray(options.mentions)) {
      options.mentions.forEach((uId) => {
        mentionsList.push({ userId: uId, mentionedBy: senderId });
      });
    }

    const processedMetadata = await processAttachmentsCloudinary(
      options?.metadata,
    );

    const payload: CreateMessagePayload = {
      projectId: resolvedProjectId,
      senderId,
      type: options?.type ?? MessageType.TEXT,
      content: trimmedContent,
      replyToId: normalizedReplyToId,
      mentions: mentionsList,
      metadata: processedMetadata,
    };

    const message = await chatRepository.createMessage(payload);
    return this.toDto(message, projectUuid);
  }

  /**
   * Send a system message (for automated notifications)
   */
  public async sendSystemMessage(
    projectId: string,
    content: string,
    metadata: IMessageMetadata,
  ): Promise<MessageDto> {
    const resolvedProjectId =
      (await resolveProjectObjectId(projectId)) || projectId;
    const projectUuid = (await resolveProjectUuid(projectId)) || projectId;

    const payload: CreateMessagePayload = {
      projectId: resolvedProjectId,
      senderId: null,
      type: MessageType.SYSTEM,
      content,
      metadata,
    };

    const message = await chatRepository.createMessage(payload);
    return this.toDto(message, projectUuid);
  }

  /**
   * Get messages for a project
   */
  public async getMessages(
    projectId: string,
    options: PaginationOptions = {},
  ): Promise<MessageListResult> {
    const resolvedProjectId =
      (await resolveProjectObjectId(projectId)) || projectId;
    const projectUuid = (await resolveProjectUuid(projectId)) || projectId;

    const messages = await chatRepository.getMessagesByProject(
      resolvedProjectId,
      {
        limit: (options.limit ?? 50) + 1, // Fetch one extra to check if there's more
        before: options.before,
        after: options.after,
      },
    );

    const hasMore = messages.length > (options.limit ?? 50);
    const slicedMessages = hasMore ? messages.slice(0, -1) : messages;

    const messagesWithReplyCount = await Promise.all(
      slicedMessages.map(async (msg) => {
        const dto = this.toDto(msg, projectUuid);
        dto.replyCount = await chatRepository.getReplyCount(msg._id.toString());
        return dto;
      }),
    );

    return {
      messages: messagesWithReplyCount.reverse(), // Oldest first for display
      hasMore,
    };
  }

  /**
   * Get thread replies for a message
   */
  public async getThreadReplies(
    projectId: string,
    messageId: string,
    options: PaginationOptions = {},
  ): Promise<MessageListResult> {
    const parentMessage = await chatRepository.getMessageByIdAndProject(
      messageId,
      projectId,
    );

    if (!parentMessage) {
      throw new HttpError(404, "Message not found");
    }

    const messages = await chatRepository.getThreadReplies(messageId, {
      limit: (options.limit ?? 50) + 1,
      before: options.before,
    });

    const hasMore = messages.length > (options.limit ?? 50);
    const slicedMessages = hasMore ? messages.slice(0, -1) : messages;

    return {
      messages: slicedMessages.map((msg) => this.toDto(msg)),
      hasMore,
    };
  }

  /**
   * Send a workspace-level message (workspace common lounge or 1-on-1 direct message)
   */
  public async sendWorkspaceMessage(
    workspaceId: string,
    senderId: string,
    content: string,
    options?: {
      recipientId?: string;
      replyToId?: string;
      mentions?: string[];
      type?: MessageType;
      metadata?: IMessageMetadata;
    },
  ): Promise<MessageDto> {
    const trimmedContent = content?.trim() ?? "";
    const hasAttachments =
      options?.metadata?.attachments &&
      Array.isArray(options.metadata.attachments) &&
      options.metadata.attachments.length > 0;

    if ((!trimmedContent || trimmedContent.length === 0) && !hasAttachments) {
      throw new HttpError(400, "Message content or attachment is required");
    }

    // Validate active workspace membership
    const WorkspaceMemberModel = (
      await import("../../workspace/models/workspace-member.model.js")
    ).default;
    const membership = await WorkspaceMemberModel.findOne({
      workspaceId,
      userId: senderId,
    });
    if (!membership) {
      throw new HttpError(
        403,
        "Only active workspace members can send messages",
      );
    }

    // If direct message, validate recipient is also in workspace
    if (options?.recipientId) {
      const recipientMember = await WorkspaceMemberModel.findOne({
        workspaceId,
        userId: options.recipientId,
      });
      if (!recipientMember) {
        throw new HttpError(404, "Recipient is not a member of this workspace");
      }
    }

    if (trimmedContent.length > this.MAX_CONTENT_LENGTH) {
      throw new HttpError(
        400,
        `Message content exceeds maximum length of ${this.MAX_CONTENT_LENGTH} characters`,
      );
    }

    const mentionsList: { userId: string; mentionedBy: string }[] = [];
    if (options?.mentions && Array.isArray(options.mentions)) {
      options.mentions.forEach((uId) => {
        mentionsList.push({ userId: uId, mentionedBy: senderId });
      });
    }

    const processedMetadata = await processAttachmentsCloudinary(
      options?.metadata,
    );

    const payload: CreateMessagePayload = {
      projectId: null,
      workspaceId,
      recipientId: options?.recipientId ?? null,
      senderId,
      type: options?.type ?? MessageType.TEXT,
      content: trimmedContent,
      replyToId: options?.replyToId ?? null,
      mentions: mentionsList,
      metadata: processedMetadata,
    };

    const message = await chatRepository.createMessage(payload);
    return this.toDto(message);
  }

  /**
   * Get messages for a workspace (common lounge or 1-on-1 direct chat)
   */
  public async getWorkspaceMessages(
    workspaceId: string,
    currentUserId: string,
    options: {
      recipientId?: string;
      limit?: number;
      before?: string;
      after?: string;
    } = {},
  ): Promise<MessageListResult> {
    const WorkspaceMemberModel = (
      await import("../../workspace/models/workspace-member.model.js")
    ).default;
    const membership = await WorkspaceMemberModel.findOne({
      workspaceId,
      userId: currentUserId,
    });
    if (!membership) {
      throw new HttpError(403, "Access denied to workspace chat");
    }

    const messages = await chatRepository.getMessagesByWorkspace(workspaceId, {
      recipientId: options.recipientId,
      currentUserId,
      limit: (options.limit ?? 50) + 1,
      before: options.before,
      after: options.after,
    });

    const hasMore = messages.length > (options.limit ?? 50);
    const slicedMessages = hasMore ? messages.slice(0, -1) : messages;

    const messagesWithReplyCount = await Promise.all(
      slicedMessages.map(async (msg) => {
        const dto = this.toDto(msg);
        dto.replyCount = await chatRepository.getReplyCount(msg._id.toString());
        return dto;
      }),
    );

    return {
      messages: messagesWithReplyCount.reverse(),
      hasMore,
    };
  }

  /**
   * Edit a message
   */
  public async editMessage(
    projectId: string,
    messageId: string,
    userId: string,
    newContent: string,
  ): Promise<MessageDto> {
    const trimmedContent = newContent.trim();

    if (!trimmedContent || trimmedContent.length === 0) {
      throw new HttpError(400, "Message content is required");
    }

    if (trimmedContent.length > this.MAX_CONTENT_LENGTH) {
      throw new HttpError(
        400,
        `Message content exceeds maximum length of ${this.MAX_CONTENT_LENGTH} characters`,
      );
    }

    const message = await chatRepository.getMessageByIdAndProject(
      messageId,
      projectId,
    );

    if (!message) {
      throw new HttpError(404, "Message not found");
    }

    if (message.isDeleted) {
      throw new HttpError(400, "Cannot edit deleted message");
    }

    // Only sender can edit
    if (!message.senderId || message.senderId.toString() !== userId) {
      throw new HttpError(403, "Only the sender can edit this message");
    }

    // Build edit history
    const editHistory = message.metadata?.editHistory ?? [];
    editHistory.push({
      content: message.content,
      editedAt: new Date(),
    });

    const metadata: IMessageMetadata = {
      ...message.metadata,
      editHistory: editHistory.slice(-5), // Keep only last 5 edits
    };

    const updated = await chatRepository.updateMessage(messageId, {
      content: trimmedContent,
      isEdited: true,
      metadata,
    });

    if (!updated) {
      throw new HttpError(500, "Failed to update message");
    }

    return this.toDto(updated);
  }

  /**
   * Delete a message (soft delete)
   */
  public async deleteMessage(
    projectId: string,
    messageId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<void> {
    const message = await chatRepository.getMessageByIdAndProject(
      messageId,
      projectId,
    );

    if (!message) {
      throw new HttpError(404, "Message not found");
    }

    // Only sender or admin can delete
    const isSender = message.senderId?.toString() === userId;
    if (!isSender && !isAdmin) {
      throw new HttpError(
        403,
        "Only the sender or admin can delete this message",
      );
    }

    await chatRepository.softDeleteMessage(messageId);
  }

  /**
   * Add reaction to a message
   */
  public async addReaction(
    projectId: string,
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<MessageDto> {
    const message = await chatRepository.getMessageByIdAndProject(
      messageId,
      projectId,
    );

    if (!message) {
      throw new HttpError(404, "Message not found");
    }

    if (message.isDeleted) {
      throw new HttpError(400, "Cannot react to deleted message");
    }

    const updated = await chatRepository.addReaction(messageId, userId, emoji);

    if (!updated) {
      throw new HttpError(500, "Failed to add reaction");
    }

    return this.toDto(updated);
  }

  /**
   * Remove reaction from a message
   */
  public async removeReaction(
    projectId: string,
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<MessageDto> {
    const updated = await chatRepository.removeReaction(
      messageId,
      userId,
      emoji,
    );

    if (!updated) {
      throw new HttpError(404, "Message not found");
    }

    return this.toDto(updated);
  }

  /**
   * Mark messages as read
   */
  public async markMessagesAsRead(
    projectId: string,
    userId: string,
    messageIds?: string[],
  ): Promise<void> {
    await chatRepository.markMessagesAsRead(projectId, userId, messageIds);
  }

  /**
   * Get unread message count
   */
  public async getUnreadCount(
    projectId: string,
    userId: string,
  ): Promise<number> {
    return chatRepository.getUnreadCount(projectId, userId);
  }

  /**
   * Search messages
   */
  public async searchMessages(
    projectId: string,
    query: string,
    options: PaginationOptions = {},
  ): Promise<MessageListResult> {
    if (!query.trim()) {
      return { messages: [], hasMore: false };
    }

    const messages = await chatRepository.searchMessages(
      projectId,
      query.trim(),
      {
        limit: (options.limit ?? 20) + 1,
      },
    );

    const hasMore = messages.length > (options.limit ?? 20);
    const slicedMessages = hasMore ? messages.slice(0, -1) : messages;

    return {
      messages: slicedMessages.map((msg) => this.toDto(msg)),
      hasMore,
    };
  }

  /**
   * Calculate thread depth for a message
   */
  private async calculateThreadDepth(messageId: string): Promise<number> {
    let depth = 0;
    let currentId: string | null = messageId;

    while (currentId && depth < this.MAX_THREAD_DEPTH + 1) {
      const message = await chatRepository.getMessageById(currentId);
      if (!message || !message.replyToId) {
        break;
      }
      currentId = message.replyToId.toString();
      depth++;
    }

    return depth;
  }

  /**
   * Convert document to DTO
   */
  private toDto(
    message: chatRepository.ChatMessageDocument,
    explicitProjectUuid?: string,
  ): MessageDto {
    const sender = this.toSenderDto(message.senderId);
    const replyTo = message.replyToId
      ? this.toReplyToDto(
          message.replyToId as unknown as chatRepository.ChatMessageDocument,
        )
      : null;

    const recipient = this.toSenderDto((message as any).recipientId);
    const mentions = (message.mentions || []).map((m) => ({
      userId: m.userId.toString(),
      mentionedBy: m.mentionedBy.toString(),
    }));

    const rawProjectId = message.projectId
      ? message.projectId.toString()
      : null;
    const projectUuid =
      explicitProjectUuid ||
      (rawProjectId
        ? (getCachedProjectUuid(rawProjectId) ?? rawProjectId)
        : null);

    const senderId =
      sender?.id ||
      (message.senderId
        ? typeof message.senderId === "object" &&
          "_id" in (message.senderId as any)
          ? (message.senderId as any)._id.toString()
          : message.senderId.toString()
        : null);

    const recipientId =
      recipient?.id ||
      ((message as any).recipientId
        ? typeof (message as any).recipientId === "object" &&
          "_id" in (message as any).recipientId
          ? (message as any).recipientId._id.toString()
          : (message as any).recipientId.toString()
        : null);

    const replyToId =
      replyTo?.id ||
      (message.replyToId
        ? typeof message.replyToId === "object" &&
          "_id" in (message.replyToId as any)
          ? (message.replyToId as any)._id.toString()
          : message.replyToId.toString()
        : null);

    return {
      id: message._id.toString(),
      projectId: projectUuid,
      workspaceId: message.workspaceId ? message.workspaceId.toString() : null,
      recipientId,
      recipient,
      senderId,
      sender,
      type: message.type as MessageType,
      content: message.content,
      replyToId,
      replyTo,
      readBy: message.readBy.map((id) => id.toString()),
      reactions: message.reactions.map((r) => ({
        userId: r.userId.toString(),
        emoji: r.emoji,
        createdAt: r.createdAt,
      })),
      mentions,
      isEdited: message.isEdited,
      isDeleted: message.isDeleted,
      metadata: message.metadata || {},
      replyCount: 0, // Will be populated separately
      createdAt: message.createdAt!,
      updatedAt: message.updatedAt!,
    };
  }

  /**
   * Convert sender to DTO
   */
  private toSenderDto(value: unknown): SenderDto | null {
    if (value == null || typeof value !== "object") {
      return null;
    }

    const sender = value as {
      _id?: Types.ObjectId;
      email?: string;
      name?: string | null;
    };

    if (!sender._id || !sender.email) {
      return null;
    }

    return {
      id: sender._id.toString(),
      email: sender.email,
      name: sender.name ?? null,
    };
  }

  /**
   * Convert reply-to to DTO
   */
  private toReplyToDto(
    value: chatRepository.ChatMessageDocument | unknown,
  ): ReplyToDto | null {
    if (value == null || typeof value !== "object") {
      return null;
    }

    const msg = value as chatRepository.ChatMessageDocument;

    if (!msg._id) {
      return null;
    }

    return {
      id: msg._id.toString(),
      content: msg.content,
      sender: this.toSenderDto(msg.senderId),
    };
  }
  /**
   * Share a message from one project to another project
   */
  public async shareMessageToProject(
    userId: string,
    sourceMessageId: string,
    targetProjectId: string,
  ): Promise<MessageDto> {
    const sourceMessage = await chatRepository.getMessageById(sourceMessageId);
    if (!sourceMessage || sourceMessage.isDeleted) {
      throw new HttpError(404, "Source message not found");
    }
    if (!sourceMessage.projectId) {
      throw new HttpError(
        400,
        "Source message is not associated with a project",
      );
    }
    const sourceProjectId = sourceMessage.projectId.toString();
    const sourceMembership = await projectMemberRepository.getProjectMembership(
      sourceProjectId,
      userId,
    );
    if (!sourceMembership) {
      throw new HttpError(403, "Access denied to source project");
    }

    const targetMembership = await projectMemberRepository.getProjectMembership(
      targetProjectId,
      userId,
    );
    if (!targetMembership) {
      throw new HttpError(403, "Access denied to target project");
    }

    const sharedContent = `[Shared from Project]: ${sourceMessage.content}`;
    const sharedMessage = await this.sendMessage(
      targetProjectId,
      userId,
      sharedContent,
      {
        type: MessageType.TEXT,
        metadata: {
          sharedFrom: {
            sourceProjectId,
            sourceMessageId,
            sharedByUserId: userId,
            createdAt: new Date(),
          },
        },
      },
    );

    const MessageShareModel = (await import("../models/message-share.model.js"))
      .default;
    await MessageShareModel.create({
      sourceProjectId,
      targetProjectId,
      sourceMessageId,
      targetMessageId: sharedMessage.id,
      sharedByUserId: userId,
    });

    return sharedMessage;
  }

  /**
   * Create a task directly from a chat message
   */
  public async createTaskFromMessage(
    userId: string,
    messageId: string,
    options?: { title?: string; priority?: any },
  ): Promise<{ taskId: string; message: MessageDto }> {
    const message = await chatRepository.getMessageById(messageId);
    if (!message || message.isDeleted) {
      throw new HttpError(404, "Message not found");
    }

    if (!message.projectId) {
      throw new HttpError(400, "Message is not associated with a project");
    }
    const projectId = message.projectId.toString();
    const membership = await projectMemberRepository.getProjectMembership(
      projectId,
      userId,
    );
    if (!membership) {
      throw new HttpError(403, "Access denied to project");
    }

    const taskService = (await import("../../task/services/task.service.js"))
      .default;
    const taskTitle = options?.title?.trim() || message.content.slice(0, 80);
    const today = new Date().toISOString().split("T")[0];

    const task = await taskService.createTask({
      userId,
      assignedTo: userId,
      title: taskTitle,
      description: `Created from Chat Message: "${message.content}"`,
      date: today,
      priority: options?.priority || "MEDIUM",
      source: "chat",
      projectId,
    });

    // Post a system message in project chat acknowledging task creation
    const sysMsg = await this.sendMessage(
      projectId,
      userId,
      `Created task "${task.title}" from message.`,
      {
        type: MessageType.SYSTEM,
        metadata: {
          action: "task_created",
          entityId: task.id,
          entityType: "task",
        },
      },
    );

    return { taskId: task.id, message: sysMsg };
  }
}

const chatService = new ChatService();

export type { MessageDto, MessageListResult };
export default chatService;
