import { Router } from "express";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import epicController from "./../controllers/epic.controller.js";

/** One request for the epics of a whole page of projects (instead of one request per project). */
class EpicBatchRoutes implements Routes {
  public path = "/api/epics";
  public router = Router();

  constructor() {
    this.router.use(authMiddleware);
    this.router.get("/", epicController.getEpicsForProjects);
  }
}

export default EpicBatchRoutes;
