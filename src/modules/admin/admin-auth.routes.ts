import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import { Routes } from "../../interfaces/routes.interface.js";
import { findUserByEmail } from "../auth/repositories/auth.repository.js";
import authService, { HttpError } from "../auth/services/auth.service.js";
import type { IUserDocument } from "../auth/models/user.model.js";
import type { AuthResult } from "../../types/auth.js";
import AdminAuditModel from "./admin-audit.model.js";
import { isSuperAdmin } from "./super-admin.js";

const GENERIC = "Invalid email or password.";
// Checked when the account is not a platform admin, so the answer takes as long as a real password check.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const body = (result: AuthResult) => ({
  token: result.token,
  accessToken: result.accessToken,
  refreshToken: result.refreshToken,
  accessTokenExpiresIn: result.accessTokenExpiresIn,
  refreshTokenExpiresIn: result.refreshTokenExpiresIn,
  syncApiKey: result.syncApiKey,
  user: result.user,
  session: result.session,
});

const fail = (res: Response, error: unknown): void => {
  const status = error instanceof HttpError ? error.status : 500;
  // A wrong password, an unknown account and a normal account all look the same from outside.
  if (status === 401 || status === 404) {
    res.status(401).json({ error: GENERIC });
    return;
  }
  res
    .status(status)
    .json({
      error: status === 500 ? "Sign-in failed." : (error as Error).message,
    });
};

/**
 * Sign-in for the platform admin console. Only platform admins (super admins) can use it: anyone else gets the same
 * "invalid email or password" answer, and no session is ever created for them here. Normal people sign in at
 * /api/auth/login and have no access to the admin console.
 */
class AdminAuthRoutes implements Routes {
  public path = "/api/admin/auth";
  public router = Router();

  constructor() {
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: "Too many sign-in attempts, please try again in 15 minutes.",
      },
    });

    this.router.post("/login", limiter, async (req: Request, res: Response) => {
      try {
        const { email, password } = (req.body ?? {}) as {
          email?: unknown;
          password?: unknown;
        };
        if (
          typeof email !== "string" ||
          typeof password !== "string" ||
          !email ||
          !password
        ) {
          res.status(400).json({ error: "Email and password are required." });
          return;
        }
        const user = await findUserByEmail(email);
        if (!user || !isSuperAdmin(user)) {
          await bcrypt.compare(password, DUMMY_HASH);
          res.status(401).json({ error: GENERIC });
          return;
        }
        const result = await authService.login(
          { email, password },
          {
            deviceName: "Admin console",
            userAgent: req.get("user-agent") ?? null,
          },
        );
        if ("require2fa" in result) {
          res
            .status(202)
            .json({
              message: "2FA code required",
              data: { require2fa: true, email: result.email },
            });
          return;
        }
        await this.recordSignIn(user, req);
        res
          .status(200)
          .json({ message: "Login successful", data: body(result) });
      } catch (error) {
        fail(res, error);
      }
    });

    this.router.post(
      "/verify-2fa",
      limiter,
      async (req: Request, res: Response) => {
        try {
          const { email, code } = (req.body ?? {}) as {
            email?: unknown;
            code?: unknown;
          };
          if (typeof email !== "string" || typeof code !== "string") {
            res.status(400).json({ error: "Email and code are required." });
            return;
          }
          const user = await findUserByEmail(email);
          if (!user || !isSuperAdmin(user)) {
            res.status(401).json({ error: GENERIC });
            return;
          }
          const result = await authService.verify2FA(email, code, {
            deviceName: "Admin console",
            userAgent: req.get("user-agent") ?? null,
          });
          await this.recordSignIn(user, req);
          res
            .status(200)
            .json({
              message: "2FA verification successful",
              data: body(result),
            });
        } catch (error) {
          fail(res, error);
        }
      },
    );
  }

  private async recordSignIn(user: IUserDocument, req: Request): Promise<void> {
    await AdminAuditModel.create({
      actorId: user._id,
      actorEmail: user.email,
      action: "admin.sign_in",
      targetType: "platform",
      details: {},
      ip: req.ip ?? null,
    });
  }
}

export default AdminAuthRoutes;
