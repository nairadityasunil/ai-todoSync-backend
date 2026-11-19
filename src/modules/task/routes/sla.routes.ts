import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import slaController from "../../../modules/task/controllers/sla.controller.js";

class SlaRoutes implements Routes {
  public path = "/api/sla";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);
    this.router.get("/config", slaController.getConfigs);
    this.router.patch("/config", slaController.updateConfig);
    this.router.get(
      "/projects/:projectId/config",
      slaController.getProjectConfigs,
    );
    this.router.patch(
      "/projects/:projectId/enabled",
      slaController.setProjectEnabled,
    );
    this.router.patch(
      "/projects/:projectId/config",
      slaController.updateProjectConfig,
    );
    this.router.delete(
      "/projects/:projectId/config/:priority",
      slaController.resetProjectConfig,
    );
    this.router.get("/tasks/:taskId/status", slaController.getTaskStatus);
    this.router.get("/breached-tasks", slaController.getBreachedTasks);
    this.router.get("/analytics", slaController.getAnalytics);
  }
}

export default SlaRoutes;
