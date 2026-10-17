import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import { isProjectMember } from "../../../middleware/project-access.middleware.js";
import noteController from "../../../modules/note/controllers/note.controller.js";

class NoteRoutes implements Routes {
  public path = "/api";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.post(
      "/projects/:projectId/notes",
      authMiddleware,
      isProjectMember,
      noteController.createNote,
    );
    this.router.get(
      "/projects/:projectId/notes",
      authMiddleware,
      isProjectMember,
      noteController.getProjectNotes,
    );
    this.router.post(
      "/projects/:projectId/epics/:epicId/notes",
      authMiddleware,
      isProjectMember,
      noteController.createEpicNote,
    );
    this.router.get(
      "/projects/:projectId/epics/:epicId/notes",
      authMiddleware,
      isProjectMember,
      noteController.getEpicNotes,
    );
    this.router.get("/notes/:id", authMiddleware, noteController.getNote);
    this.router.put("/notes/:id", authMiddleware, noteController.updateNote);
    this.router.patch("/notes/:id", authMiddleware, noteController.updateNote);
    this.router.delete("/notes/:id", authMiddleware, noteController.deleteNote);
  }
}

export default NoteRoutes;
