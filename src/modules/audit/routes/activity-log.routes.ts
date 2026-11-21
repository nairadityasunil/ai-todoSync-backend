import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import { requireProjectRole } from "../../../middleware/project-access.middleware.js";
import activityLogController from "../../../modules/audit/controllers/activity-log.controller.js";

class ActivityLogRoutes implements Routes {
  public path = "/api/projects/:projectId/activities";
  public router = Router({ mergeParams: true });

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);
    this.router.get(
      "/",
      requireProjectRole("ADMIN"),
      activityLogController.getActivities,
    );
    this.router.get(
      "/retention-policy",
      requireProjectRole("ADMIN"),
      activityLogController.getRetentionPolicy,
    );
    this.router.patch(
      "/retention-policy",
      requireProjectRole("ADMIN"),
      activityLogController.updateRetentionPolicy,
    );
    this.router.get(
      "/verify-chain",
      requireProjectRole("ADMIN"),
      activityLogController.verifyAuditChain,
    );
  }
}

export default ActivityLogRoutes;
