/**
 * Browser sign-in lives in HttpOnly cookies, so page scripts can never read the tokens (an XSS bug cannot steal
 * a session). API clients, agents and companion devices keep using the Authorization header, which always wins.
 *
 *   pristine_at  access token, sent on every API request
 *   pristine_rt  refresh token, only sent to /api/auth/*
 *
 * Cookies are Secure and SameSite=None when the app runs on HTTPS (the portal and API live on different sites),
 * and SameSite=Lax for local http development. Because SameSite=None cookies travel on cross-site requests,
 * every state-changing request that relies on a cookie must come from an allowed origin (see assertTrustedOrigin).
 *
 * Optional env: COOKIE_SAMESITE (lax|strict|none), COOKIE_SECURE (true|false), COOKIE_DOMAIN.
 */
import type { CookieOptions, Request, Response } from "express";

import env from "../../config/env.js";
import { normalizeOrigin } from "../../middleware/sdkAuth.middleware.js";
import type { AuthResult } from "../../types/auth.js";

export const ACCESS_COOKIE = "pristine_at";
export const REFRESH_COOKIE = "pristine_rt";
/** Present when "remember me" was chosen: cookies then outlive the browser session. */
export const REMEMBER_COOKIE = "pristine_rm";
/** Sent by the portal so the JSON body of sign-in answers leaves the tokens out. */
export const AUTH_MODE_HEADER = "x-auth-mode";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const isSecure = (): boolean => {
  const forced = process.env.COOKIE_SECURE;
  if (forced === "true") return true;
  if (forced === "false") return false;
  return (
    process.env.NODE_ENV === "production" ||
    env.FRONTEND_BASE_URL.startsWith("https://")
  );
};

const sameSite = (): "lax" | "strict" | "none" => {
  const forced = (process.env.COOKIE_SAMESITE ?? "").toLowerCase();
  if (forced === "lax" || forced === "strict") return forced;
  // SameSite=None is only accepted with Secure
  if (forced === "none") return isSecure() ? "none" : "lax";
  return isSecure() ? "none" : "lax";
};

/**
 * Cross-site cookies (the portal and the API on different sites) are blocked outright by Chrome Incognito, by
 * Chrome when third-party cookies are switched off, and limited by Firefox. A Partitioned cookie ("CHIPS") is
 * allowed there: the browser keeps a separate copy per portal site, which is all the sign-in needs.
 */
const partitioned = (): boolean => isSecure() && sameSite() === "none";

const baseOptions = (path: string, maxAgeMs: number): CookieOptions => ({
  httpOnly: true,
  secure: isSecure(),
  sameSite: sameSite(),
  ...(partitioned() ? { partitioned: true } : {}),
  path,
  maxAge: maxAgeMs,
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
});

export const setAuthCookies = (
  res: Response,
  result: AuthResult,
  remember = true,
): void => {
  // Without "remember me" the cookies last until the browser is closed.
  const life = (ms: number): number | undefined => (remember ? ms : undefined);
  const opts = (path: string, ms: number): CookieOptions => {
    const o = baseOptions(path, ms);
    if (!remember) delete o.maxAge;
    return o;
  };
  res.cookie(
    ACCESS_COOKIE,
    result.accessToken ?? result.token,
    opts("/", result.accessTokenExpiresIn * 1000),
  );
  if (result.refreshToken) {
    res.cookie(
      REFRESH_COOKIE,
      result.refreshToken,
      opts("/api/auth", result.refreshTokenExpiresIn * 1000),
    );
    if (remember) {
      res.cookie(
        REMEMBER_COOKIE,
        "1",
        baseOptions(
          "/api/auth",
          life(result.refreshTokenExpiresIn * 1000) ?? 0,
        ),
      );
    } else {
      res.clearCookie(REMEMBER_COOKIE, {
        ...opts("/api/auth", 0),
        maxAge: undefined,
      });
    }
  }
};

export const clearAuthCookies = (res: Response): void => {
  const opts = baseOptions("/", 0);
  delete opts.maxAge;
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: "/api/auth" });
  res.clearCookie(REMEMBER_COOKIE, { ...opts, path: "/api/auth" });
};

/** One cookie out of a Cookie header (also used for Socket.IO handshakes). */
export const parseCookie = (
  header: string | undefined,
  name: string,
): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

export const readCookie = (req: Request, name: string): string | undefined =>
  parseCookie(req.headers.cookie, name);

/** True when the portal asked for cookie-only sign-in (tokens are left out of the response body). */
export const wantsCookieOnly = (req: Request): boolean =>
  String(req.headers[AUTH_MODE_HEADER] ?? "").toLowerCase() === "cookie";

export const trustedOrigins = (): string[] =>
  [env.FRONTEND_BASE_URL, ...(env.ALLOWED_ORIGINS || [])]
    .filter(Boolean)
    .map((o) => normalizeOrigin(o));

export const isTrustedOrigin = (origin: string | undefined): boolean =>
  !!origin && trustedOrigins().includes(normalizeOrigin(origin));

/**
 * Cross-site request forgery guard for cookie-authenticated requests that change data: the browser always
 * sends Origin (or at least Referer) on those, and it must be one of our own pages.
 */
export const requestIsTrusted = (req: Request): boolean => {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.origin;
  if (typeof origin === "string") return isTrustedOrigin(origin);
  const referer = req.headers.referer;
  if (typeof referer === "string") {
    try {
      return isTrustedOrigin(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
};

/** The response body for a sign-in: tokens are left out when the portal uses cookies. */
export const authBody = (
  req: Request,
  res: Response,
  result: AuthResult,
): Record<string, unknown> => {
  const asked = (req.body as { rememberMe?: unknown } | undefined)?.rememberMe;
  const remember =
    typeof asked === "boolean"
      ? asked
      : readCookie(req, REMEMBER_COOKIE) !== undefined
        ? readCookie(req, REMEMBER_COOKIE) === "1"
        : true;
  setAuthCookies(res, result, remember);
  const body: Record<string, unknown> = {
    token: result.token,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessTokenExpiresIn: result.accessTokenExpiresIn,
    refreshTokenExpiresIn: result.refreshTokenExpiresIn,
    syncApiKey: result.syncApiKey,
    user: result.user,
    session: result.session,
  };
  if (wantsCookieOnly(req)) {
    delete body.token;
    delete body.accessToken;
    delete body.refreshToken;
  }
  return body;
};
