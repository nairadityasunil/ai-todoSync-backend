import { Router } from "express";
import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import {
  listWorkspaces,
  createWorkspace,
  markWorkspaceUsed,
  getWorkspaceDetails,
  updateWorkspace,
  deleteWorkspace,
  listMembers,
  inviteMember,
  updateMemberRole,
  updateMemberPermissions,
  removeMember,
  leaveWorkspace,
} from "../../../modules/workspace/controllers/workspace.controller.js";

class WorkspaceRoutes implements Routes {
  public path = "/api/workspaces";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Workspace CRUD
    this.router.get("/", authMiddleware, listWorkspaces);
    this.router.post("/", authMiddleware, createWorkspace);
    this.router.post("/:id/use", authMiddleware, markWorkspaceUsed);
    this.router.post("/:id/leave", authMiddleware, leaveWorkspace);
    this.router.get("/:id", authMiddleware, getWorkspaceDetails);
    this.router.patch("/:id", authMiddleware, updateWorkspace);
    this.router.delete("/:id", authMiddleware, deleteWorkspace);

    // Member management
    this.router.get("/:id/members", authMiddleware, listMembers);
    this.router.post("/:id/members", authMiddleware, inviteMember);
    this.router.patch(
      "/:id/members/:memberUserId",
      authMiddleware,
      updateMemberRole,
    );
    this.router.patch(
      "/:id/members/:memberUserId/permissions",
      authMiddleware,
      updateMemberPermissions,
    );
    this.router.delete(
      "/:id/members/:memberUserId",
      authMiddleware,
      removeMember,
    );
  }
}

export default WorkspaceRoutes;
