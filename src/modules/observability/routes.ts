import { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import { validateSdkKeyUnified } from "../../middleware/sdkAuth.middleware.js";
import c from "./controller.js";

/**
 * Logging and tracking views: application logs (ingest and search), the live
 * event stream and person profiles. Ingest uses the SDK integration; the rest
 * is for signed-in people and only shows integrations they own.
 */
class ObservabilityRoutes implements Routes {
  public path = "/api";
  public router = Router();

  constructor() {
    const r = this.router;
    r.post("/logs", validateSdkKeyUnified, c.ingest);
    r.post("/ai/interactions", validateSdkKeyUnified, c.aiInteractions);
    r.get("/observability/logs", authMiddleware, c.search);
    r.get("/observability/logs/stats", authMiddleware, c.stats);
    r.get("/observability/live", authMiddleware, c.live);
    r.get("/observability/persons", authMiddleware, c.persons);
    r.get("/observability/persons/:identifier", authMiddleware, c.person);
  }
}

export default ObservabilityRoutes;
