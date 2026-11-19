import { Request, Response } from "express";
import commentService from "../services/comment.service.js";
import type { IUserDocument } from "../../auth/models/user.model.js";

type AuthenticatedRequest = Request & { user?: IUserDocument };

const getRouteParam = (value: string | string[] | undefined): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return "";
};

class CommentController {
  public addComment = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const taskId = getRouteParam(req.params.taskId);
      const { content } = req.body;
      const comment = await commentService.addComment(
        taskId,
        user._id.toString(),
        content,
      );

      res.status(201).json({
        message: "Comment added",
        data: { comment },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public getComments = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const taskId = getRouteParam(req.params.taskId);
      const comments = await commentService.getComments(
        taskId,
        user._id.toString(),
      );

      res.status(200).json({
        message: "Comments fetched",
        data: { comments },
      });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public updateComment = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const comment = await commentService.updateComment(
        getRouteParam(req.params.taskId),
        getRouteParam(req.params.commentId),
        user._id.toString(),
        (req.body as { content?: string } | undefined)?.content as string,
      );
      res.status(200).json({ message: "Comment updated", data: { comment } });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };

  public deleteComment = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      await commentService.deleteComment(
        getRouteParam(req.params.taskId),
        getRouteParam(req.params.commentId),
        user._id.toString(),
      );
      res.status(200).json({ message: "Comment deleted" });
    } catch (error) {
      const status = (error as any).status || 500;
      res.status(status).json({ error: (error as Error).message });
    }
  };
}

export default new CommentController();
