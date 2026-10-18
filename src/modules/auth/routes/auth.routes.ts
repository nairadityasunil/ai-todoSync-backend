import { Router } from "express";
import rateLimit from "express-rate-limit";

import { Routes } from "../../../interfaces/routes.interface.js";
import authMiddleware from "../../../middleware/auth.middleware.js";
import authController from "../../../modules/auth/controllers/auth.controller.js";

class AuthRoutes implements Routes {
  public path = "/api/auth";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    const tokenLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      message: { error: "Too many requests, please try again later." },
    });
    const refreshLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      message: { error: "Too many refresh attempts, please try again later." },
    });
    // Per-IP limits on credential and code endpoints. Codes also lock after
    // a few wrong attempts in AuthService, which covers distributed guessing.
    const authLimiter = (max: number, error: string) =>
      rateLimit({
        windowMs: 15 * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error },
      });
    const loginLimiter = authLimiter(
      20,
      "Too many sign-in attempts, please try again in 15 minutes.",
    );
    const registerLimiter = authLimiter(
      10,
      "Too many sign-up attempts, please try again later.",
    );
    const codeRequestLimiter = authLimiter(
      5,
      "Too many code requests, please try again in 15 minutes.",
    );
    const codeVerifyLimiter = authLimiter(
      10,
      "Too many attempts, please try again in 15 minutes.",
    );
    const companionLoginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: {
        error: "Too many companion login attempts, please try again later.",
      },
    });

    this.router.post("/register", registerLimiter, authController.register);
    this.router.post("/login", loginLimiter, authController.login);
    this.router.post("/refresh", refreshLimiter, authController.refresh);
    this.router.post(
      "/forgot-password",
      codeRequestLimiter,
      authController.forgotPassword,
    );
    this.router.post(
      "/verify-otp",
      codeVerifyLimiter,
      authController.verifyOtp,
    );
    this.router.post(
      "/verify-2fa",
      codeVerifyLimiter,
      authController.verify2FA,
    );
    this.router.post("/2fa/toggle", authMiddleware, authController.toggle2FA);
    this.router.post(
      "/companion-login",
      companionLoginLimiter,
      authController.companionLogin,
    );
    this.router.post(
      "/companion-keys",
      authMiddleware,
      authController.createCompanionKey,
    );
    this.router.get(
      "/devices",
      authMiddleware,
      authController.listCompanionDevices,
    );
    this.router.patch(
      "/devices/:deviceId",
      authMiddleware,
      authController.updateCompanionDevice,
    );
    this.router.delete(
      "/devices/:deviceId",
      authMiddleware,
      authController.revokeCompanionDevice,
    );
    this.router.get("/google", authController.googleRedirect);
    this.router.get("/google/callback", authController.googleCallback);
    this.router.post("/token", tokenLimiter, authController.token);
    this.router.get("/me", authMiddleware, authController.me);
    this.router.patch(
      "/regenerate-sync-key",
      authMiddleware,
      authController.regenerateSyncKey,
    );
    this.router.patch("/profile", authMiddleware, authController.updateProfile);
  }
}

export default AuthRoutes;
