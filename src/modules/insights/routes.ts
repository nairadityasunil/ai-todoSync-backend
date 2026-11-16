import { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import c from "./controller.js";

/** Product analytics: trends, funnels, retention, paths, cohorts, dashboards and metric alerts. */
class InsightsRoutes implements Routes {
  public path = "/api/insights";
  public router = Router();

  constructor() {
    this.router.use(authMiddleware);
    this.router.get("/sources", c.integrations);
    this.router.get("/schema", c.schema);
    this.router.post("/query", c.query);

    this.router.get("/saved", c.listInsights);
    this.router.post("/saved", c.createInsight);
    this.router.patch("/saved/:id", c.updateInsight);
    this.router.delete("/saved/:id", c.deleteInsight);
    this.router.post("/saved/:id/run", c.runInsight);

    this.router.get("/dashboards", c.listDashboards);
    this.router.post("/dashboards", c.createDashboard);
    this.router.get("/dashboards/:id", c.getDashboard);
    this.router.patch("/dashboards/:id", c.updateDashboard);
    this.router.delete("/dashboards/:id", c.deleteDashboard);

    this.router.get("/cohorts", c.listCohorts);
    this.router.post("/cohorts", c.createCohort);
    this.router.post("/cohorts/preview", c.cohortMembers);
    this.router.patch("/cohorts/:id", c.updateCohort);
    this.router.delete("/cohorts/:id", c.deleteCohort);
    this.router.get("/cohorts/:id/members", c.cohortMembers);

    this.router.get("/alerts", c.listAlerts);
    this.router.post("/alerts", c.createAlert);
    this.router.patch("/alerts/:id", c.updateAlert);
    this.router.delete("/alerts/:id", c.deleteAlert);
    this.router.post("/alerts/:id/check", c.checkAlert);
  }
}

export default InsightsRoutes;
