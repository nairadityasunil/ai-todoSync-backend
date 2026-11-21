import { Router } from "express";

import aiPlanningController from "../../../modules/ai-planner/controllers/ai-planning.controller.js";
import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import {
  isProjectMember,
  requireProjectRole,
} from "../../../middleware/project-access.middleware.js";

class AiPlanningRoutes implements Routes {
  public path = "/api/projects/:projectId/ai-planning";
  public router = Router({ mergeParams: true });

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);
    this.router.use(isProjectMember);

    // Settings configuration and testing endpoints
    this.router.get(
      "/settings",
      requireProjectRole("ADMIN"),
      aiPlanningController.getSettings,
    );
    this.router.put(
      "/settings",
      requireProjectRole("ADMIN"),
      aiPlanningController.updateSettings,
    );
    this.router.post(
      "/test-connection",
      requireProjectRole("ADMIN"),
      aiPlanningController.testConnection,
    );

    this.router.get("/context", aiPlanningController.getContext);
    this.router.get("/sessions", aiPlanningController.listSessions);
    this.router.post("/sessions", aiPlanningController.createSession);
    this.router.get("/sessions/:sessionId", aiPlanningController.getSession);
    this.router.post(
      "/sessions/:sessionId/messages",
      aiPlanningController.sendMessage,
    );
    this.router.post(
      "/sessions/:sessionId/drafts",
      aiPlanningController.createDraft,
    );
    this.router.post(
      "/drafts/:draftId/approve",
      aiPlanningController.approveDraft,
    );
    this.router.post(
      "/drafts/:draftId/reject",
      aiPlanningController.rejectDraft,
    );
  }
}

export default AiPlanningRoutes;
