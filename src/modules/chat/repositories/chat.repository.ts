import type { ClientSession } from "mongoose";
import ChatMessageModel, {
  type IChatMessageDocument,
  type IMessageMetadata,
  MessageType,
} from "../../../modules/chat/models/chat-message.model.js";
import { resolveProjectObjectId } from "../../../utils/project-id.js";

export type ChatMessageDocument = IChatMessageDocument;

export interface CreateMessagePayload {
  projectId?: string | null;
  workspaceId?: string | null;
  recipientId?: string | null;
  senderId: string | null;
  type?: MessageType;
  content: string;
  replyToId?: string | null;
  mentions?: { userId: string; mentionedBy: string }[];
  metadata?: IMessageMetadata;
}

export interface UpdateMessagePayload {
  content?: string;
  metadata?: IMessageMetadata;
  isEdited?: boolean;
  isDeleted?: boolean;
}

export interface PaginationOptions {
  limit?: number;
  before?: string; // Message ID to fetch messages before
  after?: string; // Message ID to fetch messages after
}

export interface WorkspacePaginationOptions extends PaginationOptions {
  recipientId?: string | null;
  currentUserId?: string | null;
}

const senderPopulation = {
  path: "senderId",
  select: "email name",
};

const recipientPopulation = {
  path: "recipientId",
  select: "email name",
};

const replyToPopulation = {
  path: "replyToId",
  select: "content senderId",
  populate: {
    path: "senderId",
    select: "email name",
  },
};

/**
 * Create a new chat message
 */
export const createMessage = async (
  payload: CreateMessagePayload,
  session?: ClientSession,
): Promise<ChatMessageDocument> => {
  const resolvedProjectId = payload.projectId
    ? (await resolveProjectObjectId(payload.projectId)) || payload.projectId
    : null;
  const message = await ChatMessageModel.create(
    [
      {
        ...payload,
        projectId: resolvedProjectId,
        workspaceId: payload.workspaceId ?? null,
        recipientId: payload.recipientId ?? null,
        type: payload.type ?? MessageType.TEXT,
        replyToId: payload.replyToId ?? null,
        senderId: payload.senderId,
        mentions: payload.mentions ?? [],
      },
    ],
    { session },
  );
  return message[0].populate([
    senderPopulation,
    replyToPopulation,
    recipientPopulation,
  ]);
};

/**
 * Get messages by project ID with pagination
 */
export const getMessagesByProject = async (
  projectId: string,
  options: PaginationOptions = {},
): Promise<ChatMessageDocument[]> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  const { limit = 50, before, after } = options;

  const query: Record<string, unknown> = {
    projectId: resolvedProjectId,
  };

  if (before) {
    query.createdAt = {
      $lt: (await ChatMessageModel.findById(before))?.createdAt ?? new Date(),
    };
  } else if (after) {
    query.createdAt = {
      $gt: (await ChatMessageModel.findById(after))?.createdAt ?? new Date(),
    };
  }

  return ChatMessageModel.find(query)
    .populate([senderPopulation, replyToPopulation, recipientPopulation])
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec();
};

/**
 * Get messages by workspace ID with pagination (common lounge or 1-on-1 direct)
 */
export const getMessagesByWorkspace = async (
  workspaceId: string,
  options: WorkspacePaginationOptions = {},
): Promise<ChatMessageDocument[]> => {
  const { limit = 50, before, after, recipientId, currentUserId } = options;

  const query: Record<string, unknown> = { workspaceId };

  if (recipientId && currentUserId) {
    // 1-on-1 direct chat
    query.$or = [
      { senderId: currentUserId, recipientId },
      { senderId: recipientId, recipientId: currentUserId },
    ];
  } else {
    // Workspace common lounge (no project, no recipient)
    query.projectId = null;
    query.recipientId = null;
  }

  if (before) {
    query.createdAt = {
      $lt: (await ChatMessageModel.findById(before))?.createdAt ?? new Date(),
    };
  } else if (after) {
    query.createdAt = {
      $gt: (await ChatMessageModel.findById(after))?.createdAt ?? new Date(),
    };
  }

  return ChatMessageModel.find(query)
    .populate([senderPopulation, replyToPopulation, recipientPopulation])
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec();
};

/**
 * Get message by ID
 */
export const getMessageById = async (
  messageId: string,
): Promise<ChatMessageDocument | null> => {
  return ChatMessageModel.findById(messageId)
    .populate([senderPopulation, replyToPopulation])
    .exec();
};

/**
 * Get message by ID within a specific project
 */
export const getMessageByIdAndProject = async (
  messageId: string,
  projectId: string,
): Promise<ChatMessageDocument | null> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return ChatMessageModel.findOne({
    _id: messageId,
    projectId: resolvedProjectId,
  })
    .populate([senderPopulation, replyToPopulation])
    .exec();
};

/**
 * Update a message
 */
export const updateMessage = async (
  messageId: string,
  updates: UpdateMessagePayload,
  session?: ClientSession,
): Promise<ChatMessageDocument | null> => {
  return ChatMessageModel.findByIdAndUpdate(messageId, updates, {
    new: true,
    session,
  })
    .populate([senderPopulation, replyToPopulation])
    .exec();
};

/**
 * Soft delete a message
 */
export const softDeleteMessage = async (
  messageId: string,
  session?: ClientSession,
): Promise<ChatMessageDocument | null> => {
  return ChatMessageModel.findByIdAndUpdate(
    messageId,
    { isDeleted: true, content: "" },
    { new: true, session },
  ).exec();
};

/**
 * Permanently delete a message
 */
export const deleteMessage = async (
  messageId: string,
  session?: ClientSession,
): Promise<boolean> => {
  const result = await ChatMessageModel.deleteOne(
    { _id: messageId },
    { session },
  ).exec();
  return result.deletedCount !== undefined && result.deletedCount > 0;
};

/**
 * Add a reaction to a message
 */
export const addReaction = async (
  messageId: string,
  userId: string,
  emoji: string,
  session?: ClientSession,
): Promise<ChatMessageDocument | null> => {
  // Remove any existing reaction from this user with the same emoji
  await ChatMessageModel.findByIdAndUpdate(
    messageId,
    {
      $pull: { reactions: { userId, emoji } },
    },
    { session },
  ).exec();

  // Add the new reaction
  return ChatMessageModel.findByIdAndUpdate(
    messageId,
    {
      $push: {
        reactions: { userId, emoji, createdAt: new Date() },
      },
    },
    { new: true, session },
  )
    .populate([senderPopulation, replyToPopulation])
    .exec();
};

/**
 * Remove a reaction from a message
 */
export const removeReaction = async (
  messageId: string,
  userId: string,
  emoji: string,
  session?: ClientSession,
): Promise<ChatMessageDocument | null> => {
  return ChatMessageModel.findByIdAndUpdate(
    messageId,
    {
      $pull: { reactions: { userId, emoji } },
    },
    { new: true, session },
  )
    .populate([senderPopulation, replyToPopulation])
    .exec();
};

/**
 * Mark messages as read by a user
 */
export const markMessagesAsRead = async (
  projectId: string,
  userId: string,
  messageIds?: string[],
  session?: ClientSession,
): Promise<void> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  const query: Record<string, unknown> = {
    projectId: resolvedProjectId,
    senderId: { $ne: userId }, // Don't mark own messages as read
    readBy: { $ne: userId },
  };

  if (messageIds && messageIds.length > 0) {
    query._id = { $in: messageIds };
  }

  await ChatMessageModel.updateMany(
    query,
    { $addToSet: { readBy: userId } },
    { session },
  ).exec();
};

/**
 * Get unread message count for a user in a project
 */
export const getUnreadCount = async (
  projectId: string,
  userId: string,
): Promise<number> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return ChatMessageModel.countDocuments({
    projectId: resolvedProjectId,
    senderId: { $ne: userId },
    readBy: { $ne: userId },
  }).exec();
};

/**
 * Get reply count for a message
 */
export const getReplyCount = async (messageId: string): Promise<number> => {
  return ChatMessageModel.countDocuments({
    replyToId: messageId,
    isDeleted: false,
  }).exec();
};

/**
 * Get thread replies for a message
 */
export const getThreadReplies = async (
  messageId: string,
  options: PaginationOptions = {},
): Promise<ChatMessageDocument[]> => {
  const { limit = 50 } = options;

  return ChatMessageModel.find({
    replyToId: messageId,
    isDeleted: false,
  })
    .populate([senderPopulation, replyToPopulation])
    .sort({ createdAt: 1 })
    .limit(limit)
    .exec();
};

/**
 * Search messages in a project
 */
export const searchMessages = async (
  projectId: string,
  query: string,
  options: PaginationOptions = {},
): Promise<ChatMessageDocument[]> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  const { limit = 20 } = options;

  const searchRegex = { $regex: query.trim(), $options: "i" };

  return ChatMessageModel.find({
    projectId: resolvedProjectId,
    content: searchRegex,
    isDeleted: false,
  })
    .populate([senderPopulation, replyToPopulation])
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec();
};

/**
 * Delete all messages in a project (for project deletion)
 */
export const deleteAllMessagesInProject = async (
  projectId: string,
  session?: ClientSession,
): Promise<void> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  await ChatMessageModel.deleteMany(
    { projectId: resolvedProjectId },
    { session },
  ).exec();
};
