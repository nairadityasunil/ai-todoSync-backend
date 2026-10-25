import type { NextFunction, Request, Response } from "express";
import env from "../../../config/env.js";
import type { IUserDocument } from "../../auth/models/user.model.js";
import {
  extractApiKey,
  resolveJwtAuth,
  resolveSessionAgent,
} from "../../../middleware/auth.middleware.js";
import agentService, {
  AgentAccessError,
  agentBlockReason,
  ALL_AGENT_SCOPES,
  STANDARD_AGENT_SCOPES,
} from "../../agents/agent.service.js";
import type { IAgentDocument } from "../../agents/model.js";
import { withRequestContext } from "../../agents/request-context.js";
import type { McpScope } from "../registry/tool-types.js";

export interface McpAuthenticatedRequest extends Request {
  mcpUser?: IUserDocument;
  mcpUserId?: string;
  mcpScopes?: McpScope[];
  mcpAgent?: IAgentDocument;
}

const getBearerToken = (authHeader: string | undefined): string | undefined => {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
};

const headerValue = (value: string | string[] | undefined): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const trimSlash = (origin: string): string => origin.replace(/\/$/, "");
const PORTAL_ORIGINS = new Set(
  [env.FRONTEND_BASE_URL, ...(env.ALLOWED_ORIGINS ?? [])]
    .filter(Boolean)
    .map(trimSlash),
);

/** Requests from the portal's own pages carry one of its configured origins. */
const isPortalOrigin = (origin: string | string[] | undefined): boolean => {
  const value = headerValue(origin);
  return value !== null && PORTAL_ORIGINS.has(trimSlash(value));
};

/**
 * MCP authentication middleware.
 *
 * Every MCP caller is an agent: an API key resolves to its key agent, and a
 * signed-in session registers (or reuses) an agent for the MCP client named
 * in X-MCP-Client or the User-Agent. Scopes come from that agent, so
 * workspace:admin is only available to agents created by workspace admins.
 */
export const mcpAuthMiddleware = async (
  req: McpAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;
  const bearerToken = getBearerToken(
    typeof authHeader === "string" ? authHeader : undefined,
  );

  let user: IUserDocument | null = null;
  let agent: IAgentDocument | null = null;
  let personScopes: McpScope[] | null = null;

  try {
    const jwtAuth = bearerToken ? await resolveJwtAuth(bearerToken) : null;
    if (jwtAuth) {
      user = jwtAuth.user;
      const sessionAgent = await resolveSessionAgent(
        jwtAuth.user,
        jwtAuth.session,
      );
      const clientName = headerValue(req.headers["x-mcp-client"]);
      if (sessionAgent) {
        agent = sessionAgent;
      } else if (!clientName && isPortalOrigin(req.headers.origin)) {
        // The portal itself (a person in a browser), e.g. browsing the tool
        // manifest in Settings: not an agent. Any other caller registers as
        // an MCP client and is governed.
        personScopes = (await agentService.isWorkspaceAdminAnywhere(
          jwtAuth.user._id.toString(),
        ))
          ? ALL_AGENT_SCOPES
          : STANDARD_AGENT_SCOPES;
      } else {
        agent = await agentService.registerMcpClient(jwtAuth.user, {
          clientName,
          userAgent: headerValue(req.headers["user-agent"]),
          sessionId: jwtAuth.session._id.toString(),
        });
      }
    } else {
      const apiKey = extractApiKey(req);
      const resolved = apiKey ? await agentService.resolveApiKey(apiKey) : null;
      if (resolved) {
        user = resolved.user;
        agent = resolved.agent;
      }
    }
  } catch (error) {
    if (error instanceof AgentAccessError) {
      res.status(403).json({ error: "agent_blocked", message: error.message });
      return;
    }
    throw error;
  }

  if (!user || (!agent && !personScopes)) {
    res.status(401).json({
      error: "unauthorized",
      message: "Authentication required for MCP access",
    });
    return;
  }

  const blocked = agent ? agentBlockReason(agent) : null;
  if (agent && blocked) {
    res.status(403).json({
      error: "agent_blocked",
      message: `Agent "${agent.name}" is ${blocked}.`,
    });
    return;
  }

  req.mcpUser = user;
  req.mcpUserId = user._id.toString();
  req.mcpAgent = agent ?? undefined;
  req.mcpScopes = agent ? [...agent.scopes] : [...(personScopes ?? [])];

  const body = (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
  withRequestContext(
    {
      userId: req.mcpUserId,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
    },
    () => next(),
  );
};
