import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import taskController from "../../../modules/task/controllers/task.controller.js";

class TaskRoutes implements Routes {
  public path = "/api/tasks";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);
    this.router.get("/", taskController.getTasks);
    this.router.get("/assigned", taskController.getTasksAssignedToMe);
    this.router.get("/summary", taskController.taskSummary);
    this.router.post("/", taskController.createTask);
    this.router.patch("/:id/status", taskController.updateTaskStatus);
    this.router.patch("/:id/block", taskController.markTaskBlocked);
    this.router.patch("/:id/unblock", taskController.unblockTask);
    this.router.patch("/:id/assign", taskController.assignTask);
    this.router.patch("/:id/reassign", taskController.reassignTask);
    this.router.post("/bulk-assign", taskController.bulkAssignTasks);
    this.router.post("/:id/notes", taskController.addNote);
    this.router.patch("/:id/notes/:noteId", taskController.updateNote);
    this.router.delete("/:id/notes/:noteId", taskController.deleteNote);
    this.router.patch("/:id", taskController.updateTask);
    this.router.post("/:id/subtasks", taskController.addSubtasks);
    this.router.delete("/:id", taskController.deleteTask);
  }
}

export default TaskRoutes;
