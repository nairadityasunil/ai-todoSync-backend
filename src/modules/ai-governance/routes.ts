import { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import c from "./controller.js";

/**
 * AI governance: the inventory of AI use cases and their lifecycle. Any
 * workspace member can propose and read; owners and admins approve and decide.
 * Agents may read and log interactions, never decide (see the REST guard).
 */
class AiGovernanceRoutes implements Routes {
  public path = "/api/ai-governance";
  public router = Router();

  constructor() {
    const r = this.router;
    r.use(authMiddleware);
    r.get("/catalog", c.catalog);
    r.get("/overview", c.overview);
    r.get("/ungoverned", c.ungoverned);
    r.get("/assets", c.assets);
    r.get("/settings", c.getSettings);
    r.patch("/settings", c.updateSettings);
    r.get("/export", c.exportInventory);

    r.get("/issues", c.listIssues);
    r.post("/issues", c.createIssue);
    r.patch("/issues/:issueId", c.updateIssue);

    r.get("/use-cases", c.list);
    r.post("/use-cases", c.create);
    r.get("/use-cases/:id", c.get);
    r.patch("/use-cases/:id", c.update);
    r.delete("/use-cases/:id", c.remove);
    r.put("/use-cases/:id/assessment", c.assessment);
    r.get("/use-cases/:id/suggested-risks", c.suggestedRisks);
    r.post("/use-cases/:id/risks", c.addRisks);
    r.patch("/use-cases/:id/risks/:riskId", c.updateRisk);
    r.delete("/use-cases/:id/risks/:riskId", c.removeRisk);
    r.post("/use-cases/:id/approvals", c.decide);
    r.post("/use-cases/:id/advance", c.advance);
    r.post("/use-cases/:id/transition", c.transition);
    r.post("/use-cases/:id/attest", c.attest);
    r.post("/use-cases/:id/records", c.ingest);
    r.get("/use-cases/:id/records", c.records);
    r.post("/use-cases/:id/evaluate", c.evaluate);
    r.post("/use-cases/:id/baseline", c.baseline);
    r.get("/use-cases/:id/factsheet", c.factsheet);
  }
}

export default AiGovernanceRoutes;
