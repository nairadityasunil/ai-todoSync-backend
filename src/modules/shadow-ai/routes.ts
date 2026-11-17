import { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import c from "./controller.js";

/**
 * Shadow AI: AI tools in use that nobody approved. Admins discover, decide and
 * export policy. Any member can declare a tool or ask for one. Log forwarders
 * and scanners use a server-side token on /ingest, never a public SDK key.
 */
class ShadowAiRoutes implements Routes {
  public path = "/api/shadow-ai";
  public router = Router();

  constructor() {
    const r = this.router;
    // Token routes first: they have their own authentication.
    r.post("/ingest/signals", c.ingestSignals);
    r.post("/ingest/code", c.ingestCode);
    r.get("/ingest/decision", c.checkHost);
    r.get("/ingest/blocklist", c.blocklistFeed);
    r.post("/ingest/inspect", c.inspect);

    r.use(authMiddleware);
    r.get("/catalog", c.catalog);
    r.get("/overview", c.overview);
    r.get("/settings", c.getSettings);
    r.patch("/settings", c.updateSettings);
    r.get("/policy", c.policy);
    r.post("/monitor/run", c.runMonitor);

    r.get("/tools", c.tools);
    r.get("/tools/:id", c.tool);
    r.post("/tools/:id/decision", c.decide);
    r.post("/tools/:id/reopen", c.reopen);

    r.post("/import/log", c.importLog);
    r.post("/import/signals", c.signals);
    r.post("/scan", c.scan);

    r.get("/connectors", c.connectors);
    r.post("/connectors", c.addConnector);
    r.post("/connectors/:id/sync", c.syncConnector);
    r.delete("/connectors/:id", c.removeConnector);

    r.get("/tokens", c.tokens);
    r.post("/tokens", c.createToken);
    r.delete("/tokens/:id", c.revokeToken);

    r.get("/requests", c.requests);
    r.post("/requests", c.declare);
    r.post("/requests/:id/decision", c.decideRequest);
    r.post("/requests/:id/withdraw", c.withdrawRequest);
  }
}

export default ShadowAiRoutes;
