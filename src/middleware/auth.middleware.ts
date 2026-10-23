import { NextFunction, Request, Response } from "express";

import logger from "../lib/logger.js";
import type { IUserDocument } from "../modules/auth/models/user.model.js";
import { findCompanionDeviceById } from "../modules/ai/repositories/companion-device.repository.js";
import { findUserById } from "../modules/auth/repositories/auth.repository.js";
import agentService, {
  AgentAccessError,
  agentBlockReason,
} from "../modules/agents/agent.service.js";
import approvalService from "../modules/agents/approval.service.js";
import type { IAgentDocument } from "../modules/agents/model.js";
import { withRequestContext } from "../modules/agents/request-context.js";
import { guardAgentRequest } from "../modules/agents/rest-guard.js";
import { findActiveDeviceSessionById } from "../modules/auth/repositories/device-session.repository.js";
import type { IDeviceSessionDocument } from "../modules/auth/models/device-session.model.js";
import authService from "../modules/auth/services/auth.service.js";
import type { AuthenticatedRequest } from "../types/auth.js";

const respondUnauthorized = (res: Response): Response =>
  res.status(401).json({ error: "Unauthorized" });

const getHeaderValue = (
  value: string | string[] | undefined,
): string | undefined => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : undefined;
  }

  if (Array.isArray(value)) {
    const firstValue = value.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim() !== "",
    );
    return firstValue?.trim();
  }

  return undefined;
};

const getBearerToken = (
  authorizationHeader: string | undefined,
): string | undefined => {
  if (!authorizationHeader) {
    return undefined;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
};

interface JwtAuth {
  user: IUserDocument;
  session: IDeviceSessionDocument;
  companionDevice: Awaited<ReturnType<typeof findCompanionDeviceById>>;
}

/**
 * Resolves the user and device session behind an access token, rejecting
 * revoked sessions and devices. User and session load in parallel, so this
 * costs one database round trip (two for companion devices).
 */
export const resolveJwtAuth = async (
  token: string,
): Promise<JwtAuth | null> => {
  try {
    const decoded = authService.verifyAccessToken(token);
    const userId =
      typeof decoded.userId === "string" ? decoded.userId : undefined;
    const sessionId =
      typeof decoded.sessionId === "string" ? decoded.sessionId : undefined;

    if (!userId || !sessionId) {
      return null;
    }

    const now = new Date();
    const [user, session] = await Promise.all([
      findUserById(userId),
      findActiveDeviceSessionById(sessionId, now),
    ]);

    if (user == null || session == null) {
      return null;
    }

    if (session.deviceType === "companion") {
      if (session.deviceId == null) {
        return null;
      }

      const companionDevice = await findCompanionDeviceById(
        session.deviceId.toString(),
      );

      if (companionDevice == null || companionDevice.status !== "active") {
        return null;
      }
      return { user, session, companionDevice };
    }

    return { user, session, companionDevice: null };
  } catch (error) {
    logger.error(
      "Failed to verify JWT",
      error instanceof Error ? error : new Error("Invalid JWT token"),
    );
    return null;
  }
};

/** Resolves a user from an access token, rejecting revoked sessions and devices. */
export const resolveUserFromJwt = async (
  token: string,
): Promise<IUserDocument | null> => (await resolveJwtAuth(token))?.user ?? null;

/** The raw API key a request carries, if any. */
export const extractApiKey = (req: Request): string | undefined => {
  const authorizationHeader = getHeaderValue(req.headers.authorization);
  return (
    getHeaderValue(req.headers["x-sync-api-key"]) ??
    getBearerToken(authorizationHeader) ??
    (typeof req.query.apiKey === "string" ? req.query.apiKey.trim() : undefined)
  );
};

/**
 * The agent behind a signed-in session: ChatGPT Actions sessions carry an
 * agentId, companion devices register themselves. Portal sessions have none.
 */
export const resolveSessionAgent = async (
  user: IUserDocument,
  session: IDeviceSessionDocument,
): Promise<IAgentDocument | null> => {
  if (session.agentId) return agentService.getById(session.agentId.toString());
  if (session.deviceType === "companion" && session.deviceId) {
    return agentService.registerCompanion(
      user,
      session.deviceId.toString(),
      session.deviceName,
    );
  }
  return null;
};

const respondAgentBlocked = (
  res: Response,
  agent: IAgentDocument,
  reason: string,
): void => {
  res.status(403).json({
    error: "agent_blocked",
    code: "AGENT_BLOCKED",
    message: `Agent "${agent.name}" is ${reason}.`,
  });
};

const contextFor = (req: Request, userId: string) => {
  const body = (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
  const projectId = body.projectId ?? req.query.projectId;
  return {
    userId,
    projectId: typeof projectId === "string" ? projectId : null,
  };
};

const SYNC_KEY_AUTH = {
  sessionId: null,
  deviceId: null,
  deviceType: "sync_key",
  deviceName: "Sync API Key",
  companionDeviceType: null,
  authMethod: "sync_api_key",
} as const;

/** An approved agent request replayed by the approvals service. */
const handleReplay = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  token: string,
): Promise<void> => {
  const replay = await approvalService.consumeReplayToken(
    token,
    req.method.toUpperCase(),
    req.originalUrl,
  );
  if (!replay) {
    respondUnauthorized(res);
    return;
  }
  req.user = replay.user;
  req.deviceSession = null;
  req.agent = replay.agent;
  req.agentApprovalId = replay.approval._id.toString();
  req.auth = { ...SYNC_KEY_AUTH, agentId: replay.agent._id.toString() };
  withRequestContext(contextFor(req, replay.user._id.toString()), () => next());
};

const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Nested routers (e.g. /api/projects and /api/projects/:id/epics) both run
  // this middleware; authenticate once per request.
  if (req.user && req.auth) {
    next();
    return;
  }

  const replayToken = getHeaderValue(req.headers["x-agent-replay"]);
  if (replayToken) {
    await handleReplay(req, res, next, replayToken);
    return;
  }

  const authorizationHeader = getHeaderValue(req.headers.authorization);
  const bearerToken = getBearerToken(authorizationHeader);
  const jwtAuth = bearerToken ? await resolveJwtAuth(bearerToken) : null;

  if (jwtAuth) {
    const { user, session, companionDevice } = jwtAuth;
    req.user = user;
    req.deviceSession = session;
    req.auth = {
      sessionId: session._id.toString(),
      deviceId: session.deviceId?.toString() ?? null,
      deviceType: session.deviceType,
      deviceName: session.deviceName,
      companionDeviceType: session.companionDeviceType ?? null,
      authMethod: "access_token",
    };
    if (companionDevice) {
      req.companionDevice = companionDevice;
    }
    const context = contextFor(req, user._id.toString());
    const agent = await resolveSessionAgent(user, session);
    if (!agent) {
      withRequestContext(context, () => next());
      return;
    }
    const blocked = agentBlockReason(agent);
    if (blocked) {
      respondAgentBlocked(res, agent, blocked);
      return;
    }
    req.agent = agent;
    req.auth.agentId = agent._id.toString();
    await withRequestContext(context, () =>
      guardAgentRequest(req, res, next, agent, user._id.toString()),
    );
    return;
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    respondUnauthorized(res);
    return;
  }

  let resolved: Awaited<ReturnType<typeof agentService.resolveApiKey>>;
  try {
    resolved = await agentService.resolveApiKey(apiKey);
  } catch (error) {
    if (error instanceof AgentAccessError) {
      res
        .status(403)
        .json({
          error: "agent_blocked",
          code: error.code,
          message: error.message,
        });
      return;
    }
    throw error;
  }
  if (resolved == null) {
    logger.warn("Unknown API key - unauthorized");
    respondUnauthorized(res);
    return;
  }

  req.user = resolved.user;
  req.deviceSession = null;
  req.agent = resolved.agent;
  req.auth = { ...SYNC_KEY_AUTH, agentId: resolved.agent._id.toString() };
  const userId = resolved.user._id.toString();
  await withRequestContext(contextFor(req, userId), () =>
    guardAgentRequest(req, res, next, resolved.agent, userId),
  );
};

export default authMiddleware;
