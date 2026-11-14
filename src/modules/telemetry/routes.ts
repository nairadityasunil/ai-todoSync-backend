import { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import c from "./controller.js";

/**
 * Telemetry that stays inside Pristine: health signals, governance and agent
 * metrics, what a user did, and the tasks the system opens from them.
 * Agents may read; changes they make are held for a person by the REST guard.
 */
class TelemetryRoutes implements Routes {
  public path = "/api/telemetry";
  public router = Router();

  constructor() {
    this.router.use(authMiddleware);
    this.router.get("/health", c.health);
    this.router.get("/governance", c.governance);
    this.router.get("/agents", c.agents);
    this.router.get("/people", c.people);
    this.router.get("/journey", c.journey);
    this.router.get("/automation", c.automation);
    this.router.patch("/automation", c.updateAutomation);
    this.router.post("/automation/run", c.run);
    this.router.get("/automation/task/:taskId", c.forTask);
    this.router.get("/projects/governance", c.projectGovernance);
  }
}

export default TelemetryRoutes;
