import { Router } from "express";
import type { Response } from "express";
import type { Routes } from "../../interfaces/routes.interface.js";
import { mcpAuthMiddleware } from "./auth/mcp-auth.middleware.js";
import type { McpAuthenticatedRequest } from "./auth/mcp-auth.middleware.js";
import { callTool, listTools } from "./mcp.server.js";
import { fetchResource } from "./resources/mcp.resources.js";
import { listMcpPrompts, getMcpPrompt } from "./prompts/mcp.prompts.js";
import { McpError } from "./errors/mcp-error.js";
import type { McpScope } from "./registry/tool-types.js";
import logger from "../../lib/logger.js";

class McpRoutes implements Routes {
  public path = "/api/mcp";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.router.use(mcpAuthMiddleware);

    /**
     * GET /api/mcp/tools
     * List all MCP tools accessible to the authenticated user.
     */
    this.router.get(
      "/tools",
      (req: McpAuthenticatedRequest, res: Response): void => {
        const tools = listTools(req.mcpScopes as McpScope[]);
        res.json({
          tools,
          count: tools.length,
          scopes: req.mcpScopes,
          agent: req.mcpAgent
            ? {
                id: req.mcpAgent._id.toString(),
                name: req.mcpAgent.name,
                kind: req.mcpAgent.kind,
                projectIds: (req.mcpAgent.projectIds ?? []).map(String),
              }
            : null,
        });
      },
    );

    /**
     * POST /api/mcp/tools/:toolName
     * Invoke a specific MCP tool.
     */
    this.router.post(
      "/tools/:toolName",
      async (req: McpAuthenticatedRequest, res: Response): Promise<void> => {
        const { toolName } = req.params as { toolName: string };
        const userId = req.mcpUserId!;
        const userScopes = (req.mcpScopes ?? []) as McpScope[];
        const rawInput = (req.body as Record<string, unknown>) ?? {};

        try {
          const result = await callTool(
            toolName,
            userId,
            userScopes,
            rawInput,
            req.mcpAgent ?? null,
          );
          res.json(result);
        } catch (error) {
          if (error instanceof McpError) {
            res.status(error.httpStatus).json({
              error: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            });
            return;
          }
          logger.error(
            "Unexpected MCP error",
            error instanceof Error ? error : new Error(String(error)),
          );
          res.status(500).json({
            error: "internal_error",
            message: "An unexpected error occurred",
          });
        }
      },
    );

    /**
     * GET /api/mcp/resources/:type/:id
     * Fetch a structured MCP resource (workspace, project, or task).
     */
    this.router.get(
      "/resources/:type/:id",
      async (req: McpAuthenticatedRequest, res: Response): Promise<void> => {
        const { type, id } = req.params as { type: string; id: string };
        const userId = req.mcpUserId!;

        try {
          const resource = await fetchResource(type as any, id, userId);
          res.json(resource);
        } catch (error) {
          if (error instanceof McpError) {
            res.status(error.httpStatus).json({
              error: error.code,
              message: error.message,
            });
            return;
          }
          res.status(500).json({
            error: "internal_error",
            message: "Failed to fetch resource",
          });
        }
      },
    );

    /**
     * GET /api/mcp/prompts
     * List all server-provided workflow prompt templates.
     */
    this.router.get(
      "/prompts",
      (_req: McpAuthenticatedRequest, res: Response): void => {
        res.json({ prompts: listMcpPrompts() });
      },
    );

    /**
     * GET /api/mcp/prompts/:name
     * Get a specific prompt template by name.
     */
    this.router.get(
      "/prompts/:name",
      (req: McpAuthenticatedRequest, res: Response): void => {
        const { name } = req.params as { name: string };
        const prompt = getMcpPrompt(name);
        if (!prompt) {
          res.status(404).json({
            error: "not_found",
            message: `Prompt "${name}" not found`,
          });
          return;
        }
        res.json(prompt);
      },
    );

    /**
     * GET /api/mcp/health
     * Quick health check for the MCP server (does not require auth).
     */
    this.router.get(
      "/health",
      (_req: McpAuthenticatedRequest, res: Response): void => {
        const tools = listTools();
        res.json({
          status: "ok",
          toolCount: tools.length,
          timestamp: new Date().toISOString(),
        });
      },
    );
  }
}

export default McpRoutes;
