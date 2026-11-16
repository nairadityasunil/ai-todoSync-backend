import { Router } from "express";
import type { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import promptLibraryController from "../../../modules/prompt/controllers/prompt-library.controller.js";

class PromptLibraryRoutes implements Routes {
  public path = "/api/workspaces/:workspaceId/prompts";
  public router = Router({ mergeParams: true });

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);

    // Folders
    this.router.post("/folders", promptLibraryController.createFolder);
    this.router.get("/folders", promptLibraryController.listFolders);
    this.router.patch(
      "/folders/:folderId",
      promptLibraryController.updateFolder,
    );
    this.router.delete(
      "/folders/:folderId",
      promptLibraryController.deleteFolder,
    );

    // Prompts CRUD
    this.router.get("/", promptLibraryController.listPrompts);
    this.router.post("/", promptLibraryController.createPrompt);
    this.router.get("/:promptId", promptLibraryController.getPromptDetails);
    this.router.patch("/:promptId", promptLibraryController.updatePrompt);
    this.router.delete("/:promptId", promptLibraryController.deletePrompt);

    // Versioning & Comparisons
    this.router.get(
      "/:promptId/versions",
      promptLibraryController.getPromptVersions,
    );
    this.router.get(
      "/:promptId/compare",
      promptLibraryController.comparePromptVersions,
    );
    this.router.post(
      "/:promptId/publish-production",
      promptLibraryController.publishProductionVersion,
    );
    this.router.post(
      "/:promptId/versions/:version/staging",
      promptLibraryController.moveToStaging,
    );
    this.router.post(
      "/:promptId/versions/:version/development",
      promptLibraryController.moveToDevelopment,
    );

    // Deployment & Canary
    this.router.post(
      "/:promptId/deploy/direct",
      promptLibraryController.deployDirectToProduction,
    );
    this.router.post(
      "/:promptId/deploy/rollback",
      promptLibraryController.rollbackProduction,
    );
    this.router.get(
      "/:promptId/deploy/history",
      promptLibraryController.getDeploymentHistory,
    );
    this.router.post(
      "/:promptId/deploy/canary/start",
      promptLibraryController.startCanary,
    );
    this.router.post(
      "/:promptId/deploy/canary/advance",
      promptLibraryController.advanceCanary,
    );
    this.router.post(
      "/:promptId/deploy/canary/pause",
      promptLibraryController.pauseCanary,
    );
    this.router.post(
      "/:promptId/deploy/canary/resume",
      promptLibraryController.resumeCanary,
    );
    this.router.post(
      "/:promptId/deploy/canary/rollback",
      promptLibraryController.rollbackCanary,
    );
    this.router.post(
      "/:promptId/deploy/canary/cancel",
      promptLibraryController.cancelCanary,
    );
    this.router.post(
      "/:promptId/deploy/canary/complete",
      promptLibraryController.completeCanary,
    );
    this.router.get(
      "/:promptId/deploy/canary",
      promptLibraryController.getCanaryDeployment,
    );

    // Validation & Rendering Execution Engine
    this.router.post(
      "/:promptId/validate",
      promptLibraryController.validatePromptVariables,
    );
    this.router.post("/:promptId/render", promptLibraryController.renderPrompt);

    // Playground Execution Engine
    this.router.post("/playground/run", promptLibraryController.runPlayground);
    this.router.post(
      "/:promptId/playground/run",
      promptLibraryController.runPlayground,
    );

    // Favorites
    this.router.post(
      "/:promptId/favorite",
      promptLibraryController.toggleFavorite,
    );
  }
}

export default PromptLibraryRoutes;
