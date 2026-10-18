import { NextFunction, Request, Response } from "express";

import logger from "../lib/logger.js";
import type { IUserDocument } from "../modules/auth/models/user.model.js";
import { findCompanionDeviceById } from "../modules/ai/repositories/companion-device.repository.js";
import {
  findUserById,
  findUserBySyncApiKey,
} from "../modules/auth/repositories/auth.repository.js";
import { findActiveDeviceSessionById } from "../modules/auth/repositories/device-session.repository.js";
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

/** Resolves a user from an access token, rejecting revoked sessions and devices. */
export const resolveUserFromJwt = async (
  token: string,
): Promise<IUserDocument | null> => {
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
    }

    return user;
  } catch (error) {
    logger.error(
      "Failed to verify JWT",
      error instanceof Error ? error : new Error("Invalid JWT token"),
    );
    return null;
  }
};

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

const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authorizationHeader = getHeaderValue(req.headers.authorization);
  const bearerToken = getBearerToken(authorizationHeader);
  let user = bearerToken ? await resolveUserFromJwt(bearerToken) : null;

  if (user == null) {
    logger.debug("Attempting to resolve user from Sync API Key");
    user = await resolveUserFromSyncKey(req);
    if (user) {
      logger.debug(
        `Successfully resolved user: ${user.email} (ID: ${user._id})`,
      );
    } else {
      logger.warn("Failed to resolve user from Sync API Key - unauthorized");
    }
  }

  if (user == null) {
    respondUnauthorized(res);
    return;
  }

  req.user = user;

  if (bearerToken) {
    try {
      const decoded = authService.verifyAccessToken(bearerToken);
      const sessionId =
        typeof decoded.sessionId === "string" ? decoded.sessionId : null;
      const session =
        sessionId != null
          ? await findActiveDeviceSessionById(sessionId, new Date())
          : null;

      if (session != null) {
        req.deviceSession = session;
        req.auth = {
          sessionId: session._id.toString(),
          deviceId: session.deviceId?.toString() ?? null,
          deviceType: session.deviceType,
          deviceName: session.deviceName,
          companionDeviceType: session.companionDeviceType ?? null,
          authMethod: "access_token",
        };

        if (session.deviceType === "companion" && session.deviceId != null) {
          req.companionDevice = await findCompanionDeviceById(
            session.deviceId.toString(),
          );
        }
      }
    } catch {
      req.deviceSession = null;
      req.auth = {
        sessionId: null,
        deviceId: null,
        deviceType: "sync_key",
        deviceName: "Sync API Key",
        companionDeviceType: null,
        authMethod: "sync_api_key",
      };
    }
  } else {
    req.auth = {
      sessionId: null,
      deviceId: null,
      deviceType: "sync_key",
      deviceName: "Sync API Key",
      companionDeviceType: null,
      authMethod: "sync_api_key",
    };
  }

  next();
};

export default authMiddleware;
