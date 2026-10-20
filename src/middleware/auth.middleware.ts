import { NextFunction, Request, Response } from "express";

import logger from "../lib/logger.js";
import type { IUserDocument } from "../modules/auth/models/user.model.js";
import { findCompanionDeviceById } from "../modules/ai/repositories/companion-device.repository.js";
import {
  findUserById,
  findUserBySyncApiKey,
} from "../modules/auth/repositories/auth.repository.js";
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
const resolveJwtAuth = async (token: string): Promise<JwtAuth | null> => {
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
): Promise<IUserDocument | null> =>
  (await resolveJwtAuth(token))?.user ?? null;

const resolveUserFromSyncKey = async (
  req: Request,
): Promise<IUserDocument | null> => {
  const authorizationHeader = getHeaderValue(req.headers.authorization);
  const apiKey =
    getHeaderValue(req.headers["x-sync-api-key"]) ??
    getBearerToken(authorizationHeader) ??
    (typeof req.query.apiKey === "string"
      ? req.query.apiKey.trim()
      : undefined);

  if (!apiKey) {
    return null;
  }

  return findUserBySyncApiKey(apiKey);
};

const SYNC_KEY_AUTH = {
  sessionId: null,
  deviceId: null,
  deviceType: "sync_key",
  deviceName: "Sync API Key",
  companionDeviceType: null,
  authMethod: "sync_api_key",
} as const;

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
    next();
    return;
  }

  logger.debug("Attempting to resolve user from Sync API Key");
  const user = await resolveUserFromSyncKey(req);
  if (user == null) {
    logger.warn("Failed to resolve user from Sync API Key - unauthorized");
    respondUnauthorized(res);
    return;
  }

  logger.debug(`Successfully resolved user: ${user.email} (ID: ${user._id})`);
  req.user = user;
  req.deviceSession = null;
  req.auth = { ...SYNC_KEY_AUTH };
  next();
};

export default authMiddleware;
