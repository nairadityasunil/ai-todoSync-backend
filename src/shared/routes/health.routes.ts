import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { Routes } from "../../interfaces/routes.interface.js";
import { isDatabaseConnected } from "../../config/db.config.js";
import llmCatalogService from "../../modules/ai/services/llm-catalog.service.js";
import { listTools } from "../../modules/mcp/mcp.server.js";
import { MCP_PROMPTS } from "../../modules/mcp/prompts/mcp.prompts.js";
import PromptCanaryDeploymentModel from "../../modules/prompt/models/prompt-canary-deployment.model.js";

class HealthRoutes implements Routes {
  public path = "";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const handleDetailedHealthCheck = async (_req: Request, res: Response) => {
      const dbConnected = isDatabaseConnected();
      let pingLatencyMs: number | null = null;

      if (dbConnected && mongoose.connection.db) {
        try {
          const start = Date.now();
          await mongoose.connection.db.admin().ping();
          pingLatencyMs = Date.now() - start;
        } catch {
          pingLatencyMs = null;
        }
      }

      // 1. LLM Providers Health
      let llmProvidersStatus = "healthy";
      let activeProvidersCount = 0;
      let providersList: Array<{
        id: string;
        name: string;
        isEnabled: boolean;
      }> = [];
      try {
        const provs = await llmCatalogService.getProviders();
        providersList = provs.map((p) => ({
          id: p.providerId,
          name: p.displayName,
          isEnabled: p.isEnabled,
        }));
        activeProvidersCount = provs.filter((p) => p.isEnabled).length;
      } catch {
        llmProvidersStatus = "degraded";
      }

      // 2. MCP Tools & Workflows
      let mcpToolsCount = 0;
      let mcpStatus = "healthy";
      try {
        mcpToolsCount = listTools().length;
      } catch {
        mcpStatus = "degraded";
      }

      // 3. Active Canary Rollouts
      let activeCanaryCount = 0;
      try {
        activeCanaryCount = await PromptCanaryDeploymentModel.countDocuments({
          status: { $in: ["active", "paused"] },
        });
      } catch {
        // Ignored
      }

      // System Memory & Uptime
      const uptimeSec = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSec / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const seconds = uptimeSec % 60;
      const memory = process.memoryUsage();

      const isOverallHealthy = dbConnected && llmProvidersStatus === "healthy";
      const overallStatus = isOverallHealthy
        ? "healthy"
        : dbConnected
          ? "degraded"
          : "unhealthy";

      const healthReport = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
        // Set automatically by Render; shows which commit is deployed.
        commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
        branch: process.env.RENDER_GIT_BRANCH ?? null,
        uptime: {
          seconds: uptimeSec,
          formatted: `${hours}h ${minutes}m ${seconds}s`,
        },
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          pid: process.pid,
          memoryMB: {
            rss: (memory.rss / (1024 * 1024)).toFixed(1),
            heapTotal: (memory.heapTotal / (1024 * 1024)).toFixed(1),
            heapUsed: (memory.heapUsed / (1024 * 1024)).toFixed(1),
          },
        },
        services: {
          database: {
            status: dbConnected ? "connected" : "disconnected",
            readyState: mongoose.connection.readyState,
            dbName: mongoose.connection.name || "pristine",
            pingLatencyMs,
          },
          llmProviderCatalog: {
            status: llmProvidersStatus,
            activeProvidersCount,
            providers: providersList,
          },
          mcpServer: {
            status: mcpStatus,
            toolsRegisteredCount: mcpToolsCount,
            promptsRegisteredCount: MCP_PROMPTS.length,
          },
          canaryDeploymentEngine: {
            status: activeCanaryCount > 0 ? "active_rollouts" : "idle",
            activeRolloutsCount: activeCanaryCount,
          },
          backgroundSchedulers: {
            status: "running",
            jobs: [
              "sla_scheduler",
              "rollover_scheduler",
              "priority_engine_scheduler",
              "semantic_rollup_scheduler",
              "sdk_auth_cleanup_scheduler",
            ],
          },
        },
      };

      const statusCode = overallStatus === "unhealthy" ? 503 : 200;
      res.status(statusCode).json(healthReport);
    };

    this.router.get("/health", handleDetailedHealthCheck);
    this.router.get("/api/health", handleDetailedHealthCheck);
  }
}

export default HealthRoutes;
