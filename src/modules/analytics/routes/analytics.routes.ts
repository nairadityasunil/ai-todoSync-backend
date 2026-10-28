import { Router } from "express";
import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import {
  validateSdkKeyUnified,
  sdkAuthHandshakeLimiter,
} from "../../../middleware/sdkAuth.middleware.js";
import { requireSdkIntegrationAccess } from "../../../middleware/sdkIntegrationAuth.middleware.js";
import apiKeyController from "../../../modules/auth/controllers/apiKey.controller.js";
import trackingController from "../../../modules/analytics/controllers/tracking.controller.js";
import analyticsDataController from "../../../modules/analytics/controllers/analyticsData.controller.js";
import semanticAnalyticsController from "../../../modules/analytics/controllers/semantic-analytics.controller.js";
import mcpController from "../../../modules/ai/controllers/mcp.controller.js";
import sdkAuthController from "../../../modules/sdk/controllers/sdkAuth.controller.js";

class AnalyticsRoutes implements Routes {
  public path = "/api"; // Using /api as the base path for these routes
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    // 0. SDK AUTHENTICATION & SESSION MANAGEMENT
    this.router.post(
      "/sdk/authenticate",
      sdkAuthHandshakeLimiter,
      sdkAuthController.authenticate,
    );
    this.router.post(
      "/sdk/session/renew",
      validateSdkKeyUnified,
      sdkAuthController.renew,
    );
    this.router.post(
      "/sdk/session/revoke",
      validateSdkKeyUnified,
      sdkAuthController.revoke,
    );

    // 1. API KEY MANAGEMENT (Protected by JWT)
    this.router.post("/keys", authMiddleware, apiKeyController.createKey);
    this.router.get("/keys", authMiddleware, apiKeyController.listKeys);
    this.router.delete("/keys/:id", authMiddleware, apiKeyController.deleteKey);

    // 2. EVENT TRACKING (Protected by Dedicated SDK API Key validation)
    this.router.post("/track", validateSdkKeyUnified, trackingController.track);
    this.router.post("/batch", validateSdkKeyUnified, trackingController.batch);
    this.router.post(
      "/identify",
      validateSdkKeyUnified,
      trackingController.identify,
    );
    this.router.post("/alias", validateSdkKeyUnified, trackingController.alias);
    this.router.post("/page", validateSdkKeyUnified, trackingController.page);
    this.router.post(
      "/identify-track",
      validateSdkKeyUnified,
      trackingController.identifyTrack,
    );
    this.router.get(
      "/config",
      validateSdkKeyUnified,
      trackingController.config,
    );

    // 3. DATA FETCHING — Legacy (apiKeyId-scoped, kept for backward compat)
    this.router.get(
      "/analytics/events",
      authMiddleware,
      analyticsDataController.getEvents,
    );
    this.router.get(
      "/analytics/events/:eventId/logs",
      authMiddleware,
      analyticsDataController.getEventLogs,
    );
    this.router.get(
      "/analytics/all-logs",
      authMiddleware,
      analyticsDataController.getAllLogs,
    );
    this.router.get(
      "/analytics/users",
      authMiddleware,
      analyticsDataController.getUsers,
    );
    this.router.get(
      "/analytics/users/:identifier/events",
      authMiddleware,
      analyticsDataController.getUserEvents,
    );

    // 3b. DATA FETCHING — SDK Integration scoped (new architecture)
    this.router.get(
      "/sdk-integrations/:sdkIntegrationId/events",
      authMiddleware,
      requireSdkIntegrationAccess,
      analyticsDataController.getScopedEvents,
    );
    this.router.get(
      "/sdk-integrations/:sdkIntegrationId/events/:eventId/logs",
      authMiddleware,
      requireSdkIntegrationAccess,
      analyticsDataController.getScopedEventLogs,
    );
    this.router.get(
      "/sdk-integrations/:sdkIntegrationId/all-logs",
      authMiddleware,
      requireSdkIntegrationAccess,
      analyticsDataController.getScopedAllLogs,
    );
    this.router.get(
      "/sdk-integrations/:sdkIntegrationId/ai-traffic",
      authMiddleware,
      requireSdkIntegrationAccess,
      analyticsDataController.getAiTraffic,
    );
    this.router.get(
      "/sdk-integrations/:sdkIntegrationId/users",
      authMiddleware,
      requireSdkIntegrationAccess,
      analyticsDataController.getScopedUsers,
    );

    // 4. SEMANTIC ANALYTICS (Protected by JWT, controlled metric API)
    this.router.get(
      "/analytics/metrics",
      authMiddleware,
      semanticAnalyticsController.listMetrics,
    );
    this.router.get(
      "/analytics/metrics/:metric",
      authMiddleware,
      semanticAnalyticsController.describeMetric,
    );
    this.router.post(
      "/analytics/query-metric",
      authMiddleware,
      semanticAnalyticsController.queryMetric,
    );
    this.router.post(
      "/analytics/compare-metrics",
      authMiddleware,
      semanticAnalyticsController.compareMetrics,
    );
    this.router.post(
      "/analytics/drilldown-metric",
      authMiddleware,
      semanticAnalyticsController.drilldownMetric,
    );
    this.router.post(
      "/analytics/explain-metric",
      authMiddleware,
      semanticAnalyticsController.explainMetric,
    );
    this.router.post(
      "/analytics/replay-timeline",
      authMiddleware,
      semanticAnalyticsController.replayTimeline,
    );
    this.router.get(
      "/analytics/anomalies",
      authMiddleware,
      semanticAnalyticsController.listAnomalies,
    );
    this.router.get(
      "/analytics/trends",
      authMiddleware,
      semanticAnalyticsController.trends,
    );
    this.router.get(
      "/analytics/lineage/:metric",
      authMiddleware,
      semanticAnalyticsController.lineage,
    );
    this.router.get(
      "/analytics/governance/:metric",
      authMiddleware,
      semanticAnalyticsController.governance,
    );
    this.router.post(
      "/analytics/reasoning-summary",
      authMiddleware,
      semanticAnalyticsController.reasoningSummary,
    );
    this.router.post(
      "/analytics/rollup-snapshot",
      authMiddleware,
      semanticAnalyticsController.writeRollupSnapshot,
    );
    this.router.post(
      "/analytics/dashboard-opened",
      authMiddleware,
      semanticAnalyticsController.recordDashboardOpened,
    );
    this.router.post(
      "/analytics/forecast",
      authMiddleware,
      semanticAnalyticsController.forecast,
    );
    this.router.post(
      "/analytics/simulate",
      authMiddleware,
      semanticAnalyticsController.simulate,
    );
    this.router.get(
      "/analytics/projects/:projectId/report",
      authMiddleware,
      semanticAnalyticsController.getProjectReport,
    );

    // 5. MCP-COMPATIBLE AI TOOL LAYER (Protected by JWT, AI-safe only)
    // AI assistants discover governed tools here, never raw DB.
    this.router.get("/mcp/tools", authMiddleware, mcpController.listTools);
    this.router.post(
      "/mcp/tools/:tool",
      authMiddleware,
      mcpController.callTool,
    );
  }
}

export default AnalyticsRoutes;
