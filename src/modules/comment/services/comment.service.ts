import {
  createComment,
  getCommentsByTaskId,
} from "../../../modules/comment/repositories/comment.repository.js";
import UserModel from "../../auth/models/user.model.js";
import type { ICommentDocument } from "../models/comment.model.js";
import { escapeRegex } from "../../../utils/escape-regex.js";

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

interface CommentUserDto {
  id: string;
  email: string;
  name: string | null;
}

export interface CommentDto {
  id: string;
  taskId: string;
  userId: string;
  content: string;
  createdAt: string;
  user: CommentUserDto;
}

class CommentService {
  public async addComment(
    taskId: string,
    userId: string,
    content: string,
  ): Promise<CommentDto> {
    if (!content || content.trim() === "") {
      throw new HttpError(400, "Comment content is required");
    }

    const mentions = await this.parseMentions(content);

    const comment = await createComment({
      taskId,
      userId,
      content,
      mentions,
    });

    return this.toDto(comment);
  }

  public async getComments(taskId: string): Promise<CommentDto[]> {
    const comments = await getCommentsByTaskId(taskId);
    return comments.map((comment) => this.toDto(comment));
  }

  private async parseMentions(content: string): Promise<string[]> {
    const mentionRegex = /@(\S+)/g;
    const matches = Array.from(content.matchAll(mentionRegex));
    const mentions: string[] = [];

    for (const match of matches) {
      const handle = match[1];
      // Try to find user by email or name
      const user = await UserModel.findOne({
        $or: [
          { email: handle.toLowerCase() },
          { name: new RegExp(`^${escapeRegex(handle)}$`, "i") },
          { firstName: new RegExp(`^${escapeRegex(handle)}$`, "i") },
        ],
      })
        .select("_id")
        .exec();

      if (user) {
        mentions.push(user._id.toString());
      }
    }

    return Array.from(new Set(mentions));
  }

  private toDto(comment: ICommentDocument): CommentDto {
    const populatedUser = comment.userId as unknown as {
      _id?: { toString(): string };
      email?: string;
      name?: string | null;
      firstName?: string | null;
      lastName?: string | null;
    };

    const userName =
      populatedUser?.name ||
      [populatedUser?.firstName, populatedUser?.lastName]
        .filter(Boolean)
        .join(" ") ||
      null;

    return {
      id: comment._id.toString(),
      taskId: comment.taskId.toString(),
      userId:
        populatedUser?._id?.toString?.() ??
        (typeof comment.userId === "string" ? comment.userId : ""),
      content: comment.content,
      createdAt: comment.createdAt?.toISOString() ?? new Date().toISOString(),
      user: {
        id:
          populatedUser?._id?.toString?.() ??
          (typeof comment.userId === "string" ? comment.userId : ""),
        email: populatedUser?.email ?? "",
        name: userName,
      },
    };
  }
}

const commentService = new CommentService();
export default commentService;
