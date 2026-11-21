import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import {
  isProjectMember,
  requireProjectRole,
} from "../../../middleware/project-access.middleware.js";
import projectController from "../../../modules/project/controllers/project.controller.js";
import {
  getProjectStates,
  createProjectState,
  updateProjectState,
  deleteProjectState,
  reorderProjectStates,
} from "../../../modules/project/controllers/project-state.controller.js";

class ProjectRoutes implements Routes {
  public path = "/api/projects";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(authMiddleware);

    // Project Ownership Transfers
    this.router.get("/transfers/me", projectController.getMyTransfers);
    this.router.get("/transfers/:token", projectController.getTransferDetails);
    this.router.post(
      "/transfers/:token/accept",
      projectController.acceptTransfer,
    );
    this.router.post(
      "/transfers/:token/reject",
      projectController.rejectTransfer,
    );

    this.router.post("/", projectController.createProject);
    this.router.get("/", projectController.getProjects);
    this.router.post("/bulk-delete", projectController.bulkDeleteProjects);
    this.router.post(
      "/:projectId/leave",
      isProjectMember,
      projectController.leaveProject,
    );
    this.router.get(
      "/:projectId/members",
      isProjectMember,
      projectController.getMembers,
    );
    // Adding and removing people is restricted to project admins.
    this.router.post(
      "/:projectId/members",
      requireProjectRole("ADMIN"),
      projectController.addMember,
    );
    this.router.delete(
      "/:projectId/members/:userId",
      requireProjectRole("ADMIN"),
      projectController.removeMember,
    );
    this.router.patch(
      "/:projectId/members/:userId/permissions",
      requireProjectRole("ADMIN"),
      projectController.updateMemberPermissions,
    );
    this.router.get(
      "/:id/transfer/active",
      requireProjectRole("ADMIN"),
      projectController.getActiveTransfer,
    );
    this.router.post(
      "/:id/transfer",
      requireProjectRole("ADMIN"),
      projectController.initiateTransfer,
    );
    this.router.get("/:id", isProjectMember, projectController.getProject);
    this.router.patch(
      "/:id",
      requireProjectRole("ADMIN"),
      projectController.updateProject,
    );
    this.router.delete(
      "/:id",
      requireProjectRole("ADMIN"),
      projectController.deleteProject,
    );

    // Project Workflow States
    this.router.get("/:id/states", isProjectMember, getProjectStates);
    this.router.post(
      "/:id/states",
      requireProjectRole("ADMIN"),
      createProjectState,
    );
    this.router.patch(
      "/:id/states/reorder",
      requireProjectRole("ADMIN"),
      reorderProjectStates,
    );
    this.router.patch(
      "/:id/states/:stateId",
      requireProjectRole("ADMIN"),
      updateProjectState,
    );
    this.router.delete(
      "/:id/states/:stateId",
      requireProjectRole("ADMIN"),
      deleteProjectState,
    );
  }
}

export default ProjectRoutes;
