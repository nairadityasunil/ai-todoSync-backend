import { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import agentController from "./controller.js";

/**
 * Agent governance API. People manage agents here; agents themselves are
 * refused by the REST guard, except for polling their own approvals.
 */
class AgentRoutes implements Routes {
  public path = "/api/agents";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    const c = agentController;
    this.router.use(authMiddleware);

    this.router.get("/overview", c.overview);
    this.router.get("/catalog", c.catalog);
    this.router.post("/keys", c.createKey);
    this.router.post("/kill-switch", c.killSwitch);

    this.router.get("/activity", c.activity);
    this.router.get("/activity/export", c.exportActivity);
    this.router.post("/activity/:activityId/undo", c.undo);

    this.router.get("/policies", c.listPolicies);
    this.router.get("/policies/templates", c.policyTemplates);
    this.router.post("/policies", c.createPolicy);
    this.router.post("/policies/test", c.testPolicies);
    this.router.patch("/policies/:policyId", c.updatePolicy);
    this.router.delete("/policies/:policyId", c.deletePolicy);

    this.router.get("/approvals", c.listApprovals);
    this.router.get("/approvals/:approvalId", c.getApproval);
    this.router.post("/approvals/:approvalId/approve", c.approve);
    this.router.post("/approvals/:approvalId/reject", c.reject);

    this.router.get("/alerts", c.listAlerts);
    this.router.post("/alerts/:alertId/acknowledge", c.acknowledgeAlert);

    this.router.get("/compliance", c.compliance);
    this.router.get("/costs", c.costs);
    this.router.get("/webhooks", c.listWebhooks);
    this.router.post("/webhooks", c.createWebhook);
    this.router.patch("/webhooks/:webhookId", c.updateWebhook);
    this.router.delete("/webhooks/:webhookId", c.deleteWebhook);
    this.router.post("/webhooks/:webhookId/test", c.testWebhook);
    this.router.get("/settings", c.getSettings);
    this.router.patch("/settings", c.updateSettings);
    this.router.post("/prompt-checks", c.promptChecks);

    this.router.get("/", c.list);
    this.router.get("/:agentId", c.detail);
    this.router.patch("/:agentId", c.update);
    this.router.get("/:agentId/activity", c.activity);
    this.router.post("/:agentId/rotate", c.rotate);
    this.router.post("/:agentId/replace-with-key", c.replaceWithKey);
    this.router.post("/:agentId/review", c.review);
    this.router.get("/:agentId/reach", c.reach);
    this.router.post("/:agentId/suspend", c.suspend);
    this.router.post("/:agentId/resume", c.resume);
    this.router.post("/:agentId/revoke", c.revoke);
  }
}

export default AgentRoutes;
