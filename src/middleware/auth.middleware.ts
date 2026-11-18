import { NextFunction, Request, Response } from "express";

import logger from "../lib/logger.js";
import type { IUserDocument } from "../modules/auth/models/user.model.js";
import { findCompanionDeviceById } from "../modules/ai/repositories/companion-device.repository.js";
import { findUserById } from "../modules/auth/repositories/auth.repository.js";
import UserModel from "../modules/auth/models/user.model.js";
import DeviceSessionModel from "../modules/auth/models/device-session.model.js";
import {
  authCacheEnabled,
  getCachedAuth,
  setCachedAuth,
} from "./auth-cache.js";
import agentService, {
  AgentAccessError,
  agentBlockReason,
} from "../modules/agents/agent.service.js";
import approvalService from "../modules/agents/approval.service.js";
import type { IAgentDocument } from "../modules/agents/model.js";
import { classifyClient } from "../modules/agents/detection.js";
import { withRequestContext } from "../modules/agents/request-context.js";
import { guardAgentRequest } from "../modules/agents/rest-guard.js";
import { findActiveDeviceSessionById } from "../modules/auth/repositories/device-session.repository.js";
import type { IDeviceSessionDocument } from "../modules/auth/models/device-session.model.js";
import authService, {
  COMPANION_LIFETIME_MS,
} from "../modules/auth/services/auth.service.js";
import type { AuthenticatedRequest } from "../types/auth.js";
import {
  ACCESS_COOKIE,
  readCookie,
  requestIsTrusted,
} from "../modules/auth/auth-cookies.js";

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
    const cacheKey = `${userId}:${sessionId}`;
    let user: IUserDocument | null = null;
    let session: IDeviceSessionDocument | null = null;
    const hit = authCacheEnabled() ? getCachedAuth(cacheKey) : undefined;
    if (hit) {
      // Fresh document objects from the remembered data: no database read.
      user = UserModel.hydrate(hit.user) as IUserDocument;
      session = DeviceSessionModel.hydrate(
        hit.session,
      ) as IDeviceSessionDocument;
    } else if (authCacheEnabled()) {
      const [userRaw, sessionRaw] = await Promise.all([
        UserModel.findById(userId).lean().exec(),
        DeviceSessionModel.findOne({
          _id: sessionId,
          revokedAt: null,
          expiresAt: { $gt: now },
        })
          .lean()
          .exec(),
      ]);
      if (userRaw != null && sessionRaw != null) {
        user = UserModel.hydrate(userRaw) as IUserDocument;
        session = DeviceSessionModel.hydrate(
          sessionRaw,
        ) as IDeviceSessionDocument;
        // Companion devices are checked against their device record every time, so they are not remembered.
        if (sessionRaw.deviceType !== "companion") {
          setCachedAuth(
            cacheKey,
            userRaw as unknown as Record<string, unknown>,
            sessionRaw as unknown as Record<string, unknown>,
          );
        }
      }
    } else {
      [user, session] = await Promise.all([
        findUserById(userId),
        findActiveDeviceSessionById(sessionId, now),
      ]);
    }

    if (user == null || session == null) {
      return null;
    }

    // Suspended or deleted accounts stop working at once, even with a valid token.
    if (
      user.accountStatus === "suspended" ||
      user.accountStatus === "deleted"
    ) {
      return null;
    }

    if (session.deviceType === "companion") {
      if (session.deviceId == null) {
        return null;
      }

      const companionDevice = await findCompanionDeviceById(
        session.deviceId.toString(),
      );

      // The pairing lasts a month (devices paired before that rule count from the day they were paired).
      const pairedUntil =
        companionDevice?.expiresAt ??
        (companionDevice?.createdAt
          ? new Date(companionDevice.createdAt.getTime() + COMPANION_LIFETIME_MS)
          : null);
      if (pairedUntil != null && pairedUntil.getTime() <= now.getTime()) {
        return null;
      }

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
 * agentId. Portal sessions and paired companion devices (phones and desktops signed in by QR or key) are
 * people on their own devices, not agents, so they have none.
 */
export const resolveSessionAgent = async (
  user: IUserDocument,
  session: IDeviceSessionDocument,
): Promise<IAgentDocument | null> => {
  if (session.agentId) return agentService.getById(session.agentId.toString());
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
    message:
      agent.kind === "detected"
        ? `${agent.name} can no longer use a personal login (${reason}). Create an agent key in Agent Governance and use it instead.`
        : `Agent "${agent.name}" is ${reason}.`,
  });
};

/**
 * A script or automated browser behind a person's login becomes a "detected"
 * agent, so it is inventoried, logged and governed instead of passing as the
 * person. Browsers in the portal are left alone.
 */
const detectAgent = async (
  req: Request,
  user: IUserDocument,
  session: IDeviceSessionDocument,
): Promise<IAgentDocument | null> => {
  const detection = classifyClient({
    userAgent: getHeaderValue(req.headers["user-agent"]),
    origin: getHeaderValue(req.headers.origin),
    referer: getHeaderValue(req.headers.referer),
    secFetchMode: getHeaderValue(req.headers["sec-fetch-mode"]),
    secFetchSite: getHeaderValue(req.headers["sec-fetch-site"]),
  });
  if (!detection) return null;
  return agentService.registerDetected(user, {
    ...detection,
    userAgent: getHeaderValue(req.headers["user-agent"]) ?? null,
    sessionId: session._id.toString(),
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
    memo: new Map<string, Promise<unknown>>(),
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
  const headerToken = getBearerToken(authorizationHeader);
  // The browser portal signs in with an HttpOnly cookie; an Authorization header (API clients) wins over it.
  const cookieToken = headerToken ? undefined : readCookie(req, ACCESS_COOKIE);
  if (cookieToken && !requestIsTrusted(req)) {
    // A cookie travels on cross-site requests too, so changes must come from one of our own pages.
    res.status(403).json({ error: "Untrusted origin" });
    return;
  }
  const bearerToken = headerToken ?? cookieToken;
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
    const agent =
      (await resolveSessionAgent(user, session)) ??
      (await detectAgent(req, user, session));
    if (!agent) {
      withRequestContext(context, () => next());
      return;
    }
    const blocked = agentBlockReason(agent);
    if (blocked) {
      respondAgentBlocked(res, agent, blocked);
      return;
    }
    if (
      agent.kind === "detected" &&
      (await agentService.requiresAgentKeys(agent.workspaceId))
    ) {
      res.status(403).json({
        error: "agent_key_required",
        code: "AGENT_KEY_REQUIRED",
        message: `This workspace requires an agent key for automated access. ${agent.name} was detected using a personal login: create an agent key in Agent Governance and use it instead.`,
      });
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
      res.status(403).json({
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
