import {
  createComment,
  deleteComment,
  getCommentById,
  getCommentsByTaskId,
  updateCommentContent,
} from "../../../modules/comment/repositories/comment.repository.js";
import TaskModel from "../../task/models/task.model.js";
import { getProjectMembership } from "../../project/repositories/project-member.repository.js";
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
  /** When the text was last changed after posting, or null. */
  editedAt: string | null;
  /** The signed-in person may change or delete it: the author, or an admin of the task's project. */
  canModify: boolean;
  user: CommentUserDto;
}

class CommentService {
  /**
   * The task a person is working on, or 404 (never 403, so task ids cannot be probed). Comments are visible to the
   * task's owner and to members of its project.
   */
  private async accessFor(
    taskId: string,
    userId: string,
  ): Promise<{ isAdmin: boolean }> {
    if (!/^[a-f\d]{24}$/i.test(taskId))
      throw new HttpError(404, "Task not found");
    const task = await TaskModel.findById(taskId)
      .select("userId projectId")
      .lean()
      .exec();
    if (!task) throw new HttpError(404, "Task not found");
    const membership = task.projectId
      ? await getProjectMembership(String(task.projectId), userId)
      : null;
    if (String(task.userId) !== userId && !membership)
      throw new HttpError(404, "Task not found");
    return { isAdmin: membership?.role === "ADMIN" };
  }

  private normalizeContent(content: unknown): string {
    if (typeof content !== "string" || content.trim() === "") {
      throw new HttpError(400, "Comment content is required");
    }
    return content.trim();
  }

  public async addComment(
    taskId: string,
    userId: string,
    content: string,
  ): Promise<CommentDto> {
    const { isAdmin } = await this.accessFor(taskId, userId);
    const text = this.normalizeContent(content);
    const mentions = await this.parseMentions(text);

    const comment = await createComment({
      taskId,
      userId,
      content: text,
      mentions,
    });

    return this.toDto(comment, userId, isAdmin);
  }

  public async getComments(
    taskId: string,
    userId: string,
  ): Promise<CommentDto[]> {
    const { isAdmin } = await this.accessFor(taskId, userId);
    const comments = await getCommentsByTaskId(taskId);
    return comments.map((comment) => this.toDto(comment, userId, isAdmin));
  }

  /** Only the author or an admin of the task's project may change or delete a comment. */
  private async loadForChange(
    taskId: string,
    commentId: string,
    userId: string,
  ): Promise<{ comment: ICommentDocument; isAdmin: boolean }> {
    const { isAdmin } = await this.accessFor(taskId, userId);
    if (!/^[a-f\d]{24}$/i.test(commentId))
      throw new HttpError(404, "Comment not found");
    const comment = await getCommentById(commentId);
    if (!comment || comment.taskId.toString() !== taskId)
      throw new HttpError(404, "Comment not found");
    if (!isAdmin && this.authorId(comment) !== userId)
      throw new HttpError(
        403,
        "Only the author or a project admin can change this comment",
      );
    return { comment, isAdmin };
  }

  public async updateComment(
    taskId: string,
    commentId: string,
    userId: string,
    content: string,
  ): Promise<CommentDto> {
    const { comment, isAdmin } = await this.loadForChange(
      taskId,
      commentId,
      userId,
    );
    const text = this.normalizeContent(content);
    if (text === comment.content) return this.toDto(comment, userId, isAdmin);
    const mentions = await this.parseMentions(text);
    const updated = await updateCommentContent(commentId, text, mentions);
    if (!updated) throw new HttpError(404, "Comment not found");
    return this.toDto(updated, userId, isAdmin);
  }

  public async deleteComment(
    taskId: string,
    commentId: string,
    userId: string,
  ): Promise<void> {
    await this.loadForChange(taskId, commentId, userId);
    await deleteComment(commentId);
  }

  private authorId(comment: ICommentDocument): string {
    const populated = comment.userId as unknown as {
      _id?: { toString(): string };
    };
    return populated?._id?.toString?.() ?? String(comment.userId);
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

  private toDto(
    comment: ICommentDocument,
    viewerId: string,
    viewerIsAdmin: boolean,
  ): CommentDto {
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
      editedAt: comment.editedAt
        ? new Date(comment.editedAt).toISOString()
        : null,
      canModify: viewerIsAdmin || this.authorId(comment) === viewerId,
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
