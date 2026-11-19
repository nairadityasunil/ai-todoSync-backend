import { Router } from "express";
import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import commentController from "../../../modules/comment/controllers/comment.controller.js";

class CommentRoutes implements Routes {
  public path = "/api/tasks/:taskId/comments";
  public router = Router({ mergeParams: true });

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);
    this.router.post("/", commentController.addComment);
    this.router.get("/", commentController.getComments);
    this.router.patch("/:commentId", commentController.updateComment);
    this.router.delete("/:commentId", commentController.deleteComment);
  }
}

export default CommentRoutes;
