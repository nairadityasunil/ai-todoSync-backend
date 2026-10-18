import crypto from "crypto";
import type { Request, Response } from "express";

import env from "../../../config/env.js";
import logger from "../../../lib/logger.js";
import type { CreateUserPayload } from "../repositories/auth.repository.js";
import authService, { HttpError } from "../services/auth.service.js";
import type {
  CreateCompanionKeyInput,
  DeviceMetadataInput,
  LoginCredentials,
  UpdateCompanionDeviceInput,
} from "../../../modules/auth/services/auth.service.js";
import type { AuthResult, AuthenticatedRequest } from "../../../types/auth.js";

class AuthController {
  public register = async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password, firstName, lastName } = req.body as {
        email?: string;
        password?: string;
        firstName?: string;
        lastName?: string;
      };

      const nameParts = [firstName, lastName].filter(Boolean);
      const payload: CreateUserPayload = {
        email: email ?? "",
        password: password ?? "",
        firstName,
        lastName,
        name: nameParts.length > 0 ? nameParts.join(" ") : null,
      };
      const authResult = await authService.register(
        payload,
        this.extractDeviceMetadata(req),
      );

      res.status(201).json({
        message: "User registered successfully",
        data: this.buildAuthResponse(authResult),
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public login = async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body as {
        email?: string;
        password?: string;
      };
      const credentials: LoginCredentials = {
        email: email ?? "",
        password: password ?? "",
      };
      const authResult = await authService.login(
        credentials,
        this.extractDeviceMetadata(req),
      );

      if ("require2fa" in authResult) {
        res.status(202).json({
          message: "2FA code required",
          data: { require2fa: true, email: authResult.email },
        });
        return;
      }

      res.status(200).json({
        message: "Login successful",
        data: this.buildAuthResponse(authResult),
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public verify2FA = async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, code } = req.body as { email?: string; code?: string };
      const authResult = await authService.verify2FA(
        email ?? "",
        code ?? "",
        this.extractDeviceMetadata(req),
      );

      res.status(200).json({
        message: "2FA verification successful",
        data: this.buildAuthResponse(authResult),
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public forgotPassword = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const { email } = req.body as { email?: string };
      await authService.forgotPassword(email ?? "");
      res.status(200).json({
        message:
          "If an account exists for that email, a reset code has been sent.",
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public verifyOtp = async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, otp, password } = req.body as {
        email?: string;
        otp?: string;
        password?: string;
      };
      await authService.verifyOtp(email ?? "", otp ?? "", password ?? "");
      res.status(200).json({
        message: "Password reset successful",
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public toggle2FA = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;
      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { enabled } = req.body as { enabled?: boolean };
      const profile = await authService.toggle2FA(
        user._id.toString(),
        !!enabled,
      );
      res.status(200).json({
        message: `2FA ${enabled ? "enabled" : "disabled"} successfully`,
        data: { user: profile },
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    try {
      const { refreshToken } = req.body as { refreshToken?: string };
      const authResult = await authService.refreshTokens(refreshToken ?? "");

      res.status(200).json({
        message: "Tokens refreshed successfully",
        data: this.buildAuthResponse(authResult),
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public createCompanionKey = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      if (!this.hasPrimaryAccess(req)) {
        res
          .status(403)
          .json({ error: "Primary device authorization required" });
        return;
      }

      const body = req.body as {
        deviceName?: string;
        deviceType?: string;
      };
      const payload: CreateCompanionKeyInput = {
        deviceName: body.deviceName,
        deviceType: body.deviceType,
      };
      const result = await authService.createCompanionAccessKey(
        user._id.toString(),
        payload,
      );

      res.status(201).json({
        message: "Companion device key generated successfully",
        data: result,
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public companionLogin = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const { key, deviceName, deviceType } = req.body as {
        key?: string;
        deviceName?: string;
        deviceType?: string;
      };

      const authResult = await authService.loginCompanionDevice({
        key: key ?? "",
        deviceName,
        deviceType,
        userAgent: req.get("user-agent") ?? null,
      });

      res.status(200).json({
        message: "Companion device login successful",
        data: this.buildAuthResponse(authResult),
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public listCompanionDevices = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      if (!this.hasPrimaryAccess(req)) {
        res
          .status(403)
          .json({ error: "Primary device authorization required" });
        return;
      }

      const devices = await authService.listCompanionDevices(
        user._id.toString(),
      );

      res.status(200).json({
        message: "Companion devices fetched successfully",
        data: { devices },
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public updateCompanionDevice = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      if (!this.hasPrimaryAccess(req)) {
        res
          .status(403)
          .json({ error: "Primary device authorization required" });
        return;
      }

      const payload = req.body as { deviceName?: string; deviceType?: string };
      const updates: UpdateCompanionDeviceInput = {
        deviceName: payload.deviceName,
        deviceType: payload.deviceType,
      };
      const device = await authService.updateCompanionDevice(
        user._id.toString(),
        this.getSingleRouteParam(req.params.deviceId, "deviceId"),
        updates,
      );

      res.status(200).json({
        message: "Companion device updated successfully",
        data: { device },
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public revokeCompanionDevice = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      if (!this.hasPrimaryAccess(req)) {
        res
          .status(403)
          .json({ error: "Primary device authorization required" });
        return;
      }

      await authService.revokeCompanionDevice(
        user._id.toString(),
        this.getSingleRouteParam(req.params.deviceId, "deviceId"),
      );

      res.status(200).json({
        message: "Companion device revoked successfully",
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public googleRedirect = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const requestedRedirect = req.query.redirect as string | undefined;
      const safeRedirect = ensureInternalPath(requestedRedirect);
      const redirectUri = req.query.redirect_uri as string | undefined;
      const gptState = req.query.state as string | undefined;

      let origin =
        (req.query.origin as string) ||
        (req.headers.referer
          ? new URL(req.headers.referer).origin
          : env.FRONTEND_BASE_URL);
      const allowedOrigins = [env.FRONTEND_BASE_URL, ...env.ALLOWED_ORIGINS];
      const isAllowed = allowedOrigins.some((allowed) => {
        try {
          return new URL(allowed).origin === new URL(origin).origin;
        } catch {
          return false;
        }
      });
      if (!isAllowed) {
        origin = env.FRONTEND_BASE_URL;
      }

      const state = signState({
        redirectTo: safeRedirect,
        redirectUri: redirectUri || null,
        gptState: gptState || null,
        origin,
      });

      const authorizationUrl = authService.getGoogleAuthorizationUrl(state);
      res.redirect(authorizationUrl);
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public token = async (req: Request, res: Response): Promise<void> => {
    try {
      const { code } = req.body as { code?: string };
      const authResult = await authService.exchangeGoogleCode(
        code ?? "",
        this.extractDeviceMetadata(req),
      );

      res.status(200).json({
        access_token: authResult.accessToken,
        refresh_token: authResult.refreshToken,
        token_type: "Bearer",
        expires_in: authResult.accessTokenExpiresIn,
        refresh_expires_in: authResult.refreshTokenExpiresIn,
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public googleCallback = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const { code, state } = req.query;

      if (!code) {
        throw new Error("Missing Google OAuth code");
      }

      const decodedState = verifyState(state as string | undefined);
      const redirectUri = decodedState.redirectUri;

      if (redirectUri) {
        const separator = redirectUri.includes("?") ? "&" : "?";
        let finalUrl = `${redirectUri}${separator}code=${code}`;

        if (decodedState.gptState) {
          finalUrl += `&state=${decodedState.gptState}`;
        }

        res.redirect(finalUrl);
        return;
      }

      const authResult = await authService.exchangeGoogleCode(code as string, {
        userAgent: req.get("user-agent") ?? null,
      });

      // redirectTo is an internal path that may carry its own query string
      // (e.g. /accept-invitation?token=...), so resolve it as a URL rather
      // than assigning it to pathname, which would encode the "?".
      const redirectOrigin = new URL(
        decodedState.origin || env.FRONTEND_BASE_URL,
      ).origin;
      let finalRedirectUrl = new URL(
        ensureInternalPath(decodedState.redirectTo),
        redirectOrigin,
      );
      if (finalRedirectUrl.origin !== redirectOrigin) {
        finalRedirectUrl = new URL("/", redirectOrigin);
      }
      // Tokens go in the fragment: browsers never send it to servers, so it
      // stays out of access logs and Referer headers.
      finalRedirectUrl.hash = new URLSearchParams({
        token: authResult.accessToken,
        refreshToken: authResult.refreshToken,
      }).toString();

      logger.info(
        `Google OAuth redirecting to ${finalRedirectUrl.origin}${finalRedirectUrl.pathname}`,
      );
      res.redirect(finalRedirectUrl.toString());
    } catch (error) {
      logger.error("Google OAuth Callback Error: " + JSON.stringify(error));
      let targetOrigin = env.FRONTEND_BASE_URL;
      try {
        const state = req.query.state;
        if (state) {
          const decodedState = verifyState(state as string);
          if (decodedState.origin) {
            targetOrigin = decodedState.origin;
          }
        }
      } catch {
        // Fallback to default redirect options on decryption error
      }
      const errMsg =
        error instanceof Error ? error.message : "Google authentication failed";
      res.redirect(
        `${targetOrigin.replace(/\/$/, "")}/login?error=${encodeURIComponent(errMsg)}`,
      );
    }
  };

  public me = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const profile = await authService.getCurrentUser(user._id.toString());

      res.status(200).json({
        message: "Authenticated user profile",
        data: {
          user: profile,
          session: req.auth ?? null,
        },
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public regenerateSyncKey = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const syncApiKey = await authService.regenerateSyncKey(
        user._id.toString(),
      );

      res.status(200).json({
        message: "Sync API key regenerated",
        data: { syncApiKey },
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  public updateProfile = async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    try {
      const user = req.user;

      if (user == null) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const {
        firstName,
        lastName,
        openaiApiKey,
        anthropicApiKey,
        geminiApiKey,
      } = req.body as {
        firstName?: string;
        lastName?: string;
        openaiApiKey?: string;
        anthropicApiKey?: string;
        geminiApiKey?: string;
      };

      const profile = await authService.updateProfile(user._id.toString(), {
        firstName,
        lastName,
        openaiApiKey,
        anthropicApiKey,
        geminiApiKey,
      });

      res.status(200).json({
        message: "Profile updated successfully",
        data: { user: profile },
      });
    } catch (error) {
      this.respondWithError(res, error);
    }
  };

  private buildAuthResponse(result: AuthResult) {
    return {
      token: result.token,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExpiresIn: result.accessTokenExpiresIn,
      refreshTokenExpiresIn: result.refreshTokenExpiresIn,
      syncApiKey: result.syncApiKey,
      user: result.user,
      session: result.session,
    };
  }

  private extractDeviceMetadata(req: Request): DeviceMetadataInput {
    const body = (req.body ?? {}) as {
      deviceName?: string;
      deviceType?: string;
    };

    return {
      deviceName: body.deviceName,
      deviceType: body.deviceType,
      userAgent: req.get("user-agent") ?? null,
    };
  }

  private hasPrimaryAccess(req: AuthenticatedRequest): boolean {
    return (
      req.auth?.deviceType === "primary" || req.auth?.deviceType === "sync_key"
    );
  }

  private getSingleRouteParam(
    value: string | string[] | undefined,
    fieldName: string,
  ): string {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }

    throw new HttpError(400, `${fieldName} route parameter is required`);
  }

  private respondWithError(res: Response, error: unknown): void {
    const status = error instanceof HttpError ? error.status : 500;
    res.status(status).json({ error: (error as Error).message });
  }
}

const signState = (payload: object): string => {
  const json = JSON.stringify(payload);
  const sig = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(json)
    .digest("hex");
  return Buffer.from(JSON.stringify({ payload: json, sig })).toString(
    "base64url",
  );
};

const verifyState = (state?: string) => {
  if (!state) {
    return { redirectTo: "/", mode: "web", redirectUri: null, gptState: null };
  }

  try {
    const { payload, sig } = JSON.parse(
      Buffer.from(state, "base64url").toString(),
    );
    const expected = crypto
      .createHmac("sha256", env.JWT_SECRET)
      .update(payload)
      .digest("hex");
    const sigBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return {
        redirectTo: "/",
        mode: "web",
        redirectUri: null,
        gptState: null,
      };
    }

    const parsed = JSON.parse(payload) as {
      redirectTo?: string;
      mode?: string;
      redirectUri?: string | null;
      gptState?: string | null;
      origin?: string;
    };

    return {
      redirectTo: ensureInternalPath(parsed.redirectTo),
      mode: parsed.mode ?? "web",
      redirectUri: parsed.redirectUri ?? null,
      gptState: parsed.gptState ?? null,
      origin: parsed.origin ?? env.FRONTEND_BASE_URL,
    };
  } catch {
    return { redirectTo: "/", mode: "web", redirectUri: null, gptState: null };
  }
};

const ensureInternalPath = (value?: string | null): string => {
  // "//host" and "/\\host" are protocol-relative URLs to another site.
  if (!value || !value.startsWith("/") || /^\/[\\/]/.test(value)) {
    return "/";
  }

  return value;
};

const authController = new AuthController();

export default authController;
