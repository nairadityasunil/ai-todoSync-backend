import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { rateLimit } from "express-rate-limit";
import AnalyticsKeyModel from "../modules/analytics/models/analytics-key.model.js";
import { deterministicHash } from "../utils/encryption.js";
import sdkIntegrationService, {
  normalizeOrigin,
  matchOrigin,
} from "../modules/sdk-integrations/service.js";
export { normalizeOrigin, matchOrigin };
import logger from "../lib/logger.js";
import { SdkAuthService } from "../modules/sdk/services/sdkAuth.service.js";
import { sdkAuthConfig } from "../config/sdkAuth.config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const extractRawKey = (req: Request): string | undefined => {
  const authorizationHeader = req.headers.authorization;
  const bearerToken =
    typeof authorizationHeader === "string" &&
    authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length).trim()
      : undefined;

  return (
    bearerToken ||
    (req.headers["x-api-key"] as string) ||
    (req.headers["x-sdk-key"] as string) ||
    (req.body && req.body.apiKey) ||
    (req.body && req.body.sdkKey)
  );
};

export const setCorsHeaders = (res: Response, origin: string): void => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, x-sdk-key, x-session-id, x-timestamp, x-nonce, x-body-sha256, x-signature, x-sync-api-key, x-sdk-version",
  );
  // Let browsers reuse the preflight answer for 2 hours (Chrome's cap)
  // instead of sending an extra OPTIONS round trip before most API calls.
  res.setHeader("Access-Control-Max-Age", "7200");
  res.setHeader("Vary", "Origin");
};

const logSecurityEvent = (
  reason: string,
  req: Request,
  rawKey?: string,
  details?: any,
) => {
  const maskedKey = rawKey
    ? rawKey.startsWith("sdk_")
      ? `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`
      : "****"
    : "missing";
  logger.warn("Security Event: SDK Auth Failure", {
    reason,
    maskedKey,
    origin: req.headers.origin,
    ip: req.ip,
    method: req.method,
    url: req.originalUrl,
    ...details,
  });
};

/**
 * Validates that the request's Origin matches the integration's registered domain or allowed origins list.
 */
export const validateIntegrationOrigin = (
  origin: string | undefined,
  integration: any,
): string | null => {
  if (!origin) {
    return "Origin header is required";
  }

  try {
    const parsedOrigin = normalizeOrigin(origin);
    const domainMatches =
      integration.domain && matchOrigin(parsedOrigin, integration.domain);
    const allowedMatches = (integration.allowedOrigins || []).some(
      (o: string) => matchOrigin(parsedOrigin, o),
    );

    if (domainMatches || allowedMatches) {
      return null;
    }

    return `Origin '${parsedOrigin}' is not allowed for this integration.`;
  } catch {
    return "Invalid Origin header format";
  }
};

// ---------------------------------------------------------------------------
// Strategy Pattern for Future Non-Browser SDKs
// ---------------------------------------------------------------------------

export interface SdkAuthStrategy {
  name: string;
  supports(req: Request): boolean;
  authenticate(req: Request, integration: any): Promise<string | null>;
}

export class BrowserSdkAuthStrategy implements SdkAuthStrategy {
  name = "browser";
  supports(req: Request): boolean {
    return !!req.headers.origin;
  }
  async authenticate(req: Request, integration: any): Promise<string | null> {
    const origin = req.headers.origin;
    return validateIntegrationOrigin(origin, integration);
  }
}

export class ServerSdkAuthStrategy implements SdkAuthStrategy {
  name = "server";
  supports(req: Request): boolean {
    return !req.headers.origin;
  }
  async authenticate(_req: Request, _integration: any): Promise<string | null> {
    // Server strategies bypass browser-based Origin checks.
    return null;
  }
}

export const authStrategies: SdkAuthStrategy[] = [
  new BrowserSdkAuthStrategy(),
  new ServerSdkAuthStrategy(),
];

// ---------------------------------------------------------------------------
// Primary SDK Integration middleware (new — integration-aware)
// ---------------------------------------------------------------------------

export const validateSdkIntegrationKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  await validateSdkKeyUnified(req, res, next);
};

// ---------------------------------------------------------------------------
// Legacy AnalyticsKey middleware (backward compat)
// ---------------------------------------------------------------------------

export const validateSdkApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const rawKey = extractRawKey(req);

  if (!rawKey || typeof rawKey !== "string") {
    res.status(401).json({
      error: "API key is required in Authorization or X-API-KEY header",
    });
    return;
  }

  try {
    const keyHash = deterministicHash(rawKey);

    let keyDoc = await AnalyticsKeyModel.findOne({ keyHash, status: "active" });

    if (!keyDoc) {
      const demoHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const rawDoc = await AnalyticsKeyModel.collection.findOne({
        $or: [{ hashedKey: demoHash }, { hashedKey: rawKey }],
        status: "active",
      } as any);

      if (rawDoc) {
        keyDoc = await AnalyticsKeyModel.findById(rawDoc._id);
      }
    }

    if (!keyDoc) {
      logSecurityEvent("Invalid Legacy Key", req, rawKey);
      res.status(401).json({ error: "Invalid or revoked API key" });
      return;
    }

    const origin = req.headers.origin;
    if (keyDoc.allowedOrigins && keyDoc.allowedOrigins.length > 0 && origin) {
      try {
        const parsedOrigin = new URL(origin).origin;
        const localhostOrigin =
          parsedOrigin.includes("localhost") ||
          parsedOrigin.includes("127.0.0.1");

        if (!localhostOrigin) {
          const isAllowed = keyDoc.allowedOrigins.some((allowed) => {
            if (allowed === "*") return true;
            const cleanAllowed = allowed.replace(/\/$/, "").trim();
            if (cleanAllowed === parsedOrigin) return true;
            if (cleanAllowed.startsWith("*.")) {
              const suffix = cleanAllowed.slice(2);
              return parsedOrigin.endsWith(suffix);
            }
            return false;
          });

          if (!isAllowed) {
            logSecurityEvent("Legacy Origin Mismatch", req, rawKey);
            res.status(403).json({
              error: `Origin '${origin}' is not allowed for this SDK Key`,
            });
            return;
          }
        }
      } catch {
        res.status(400).json({ error: "Invalid Origin header format" });
        return;
      }
    }

    const UserModel = (await import("../modules/auth/models/user.model.js"))
      .default;
    const user = await UserModel.findById(keyDoc.userId);
    if (!user) {
      logSecurityEvent("Legacy Owner Not Found", req, rawKey);
      res.status(401).json({ error: "API key owner not found" });
      return;
    }

    req.user = user;
    req.analyticsKey = keyDoc;
    req.apiKeyId = keyDoc._id.toString();

    if (origin) {
      setCorsHeaders(res, origin);
    }

    next();
  } catch (error) {
    logger.error(
      "SDK Auth Middleware Error:",
      error instanceof Error ? error : new Error(String(error)),
    );
    res
      .status(500)
      .json({ error: "Internal server error during authentication" });
  }
};

// ---------------------------------------------------------------------------
// Unified SDK middleware
// ---------------------------------------------------------------------------

export const validateSdkKeyUnified = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const hasSignatureHeaders =
    req.headers["x-session-id"] && req.headers["x-signature"];

  if (hasSignatureHeaders) {
    try {
      const { session, integration, user } =
        await SdkAuthService.verifySignature(req);
      req.user = user;
      req.sdkIntegration = integration;
      req.apiKeyId = integration._id.toString();
      req.sdkSession = session;

      if (req.headers.origin) {
        setCorsHeaders(res, req.headers.origin);
      }

      next();
      return;
    } catch (error: any) {
      const status = error.status || 401;
      res.status(status).json({ error: error.message || "Unauthorized" });
      return;
    }
  }

  // If no signature headers, check if request tries to authenticate with raw SDK integration key
  const rawKey = extractRawKey(req);
  if (rawKey) {
    const keyHash = deterministicHash(rawKey);
    const integration = await sdkIntegrationService.resolveByKeyHash(keyHash);

    if (integration) {
      // Reject raw SDK key access without cryptographic signature
      logSecurityEvent(
        "Rejected Raw Key access to protected endpoint",
        req,
        rawKey,
      );
      res.status(401).json({
        error:
          "SDK key alone cannot authorize runtime requests. Cryptographic signature required.",
      });
      return;
    }
  }

  // Otherwise, fall back to legacy non-SDK API keys (backward compatibility)
  await validateSdkApiKey(req, res, next);
};

// ---------------------------------------------------------------------------
// Rate Limiters
// ---------------------------------------------------------------------------

export const sdkRateLimiter = rateLimit({
  windowMs: sdkAuthConfig.rateLimitWindowMs,
  max: sdkAuthConfig.maxRequestsPerWindow,
  keyGenerator: (req: Request) => {
    return (
      req.sdkSession?.sessionId ||
      req.sdkIntegration?.tenantId ||
      extractRawKey(req) ||
      (req as any)["ip"]
    );
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many requests. Please try again later.",
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.method === "OPTIONS",
});

export const sdkAuthHandshakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: sdkAuthConfig.maxAuthAttemptsPerMin,
  keyGenerator: (req: Request) => {
    return extractRawKey(req) || (req as any)["ip"];
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many authentication attempts. Please try again later.",
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.method === "OPTIONS",
});
