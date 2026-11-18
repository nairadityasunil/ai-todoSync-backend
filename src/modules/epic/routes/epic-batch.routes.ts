import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import epicController from "./../controllers/epic.controller.js";

/** The caller's epics across all their projects, in one request. */
class EpicBatchRoutes implements Routes {
  public path = "/api/epics";
  public router = Router();

  constructor() {
    this.router.use(authMiddleware);
    this.router.get("/", epicController.getMyEpics);
  }
}

export default EpicBatchRoutes;
