import assert from "node:assert/strict";
import test from "node:test";
import crypto from "crypto";
import mongoose from "mongoose";

import authService from "./auth.service.js";
import UserModel from "../models/user.model.js";
import DeviceSessionModel from "../models/device-session.model.js";
import { EmailService } from "../../../shared/services/email.service.js";

// Helper helper mock
function makeMockQuery(result: any) {
  return {
    exec: async () => result,
  };
}

const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

test("AuthService: forgotPassword stores a hashed OTP and emails the code", async () => {
  let sentEmail: string | null = null;
  let sentOtp: string | null = null;
  let sentType: string | null = null;

  const originalSendOtpEmail = EmailService.sendOtpEmail;
  EmailService.sendOtpEmail = async (
    to: string,
    otp: string,
    purpose: "forgot_password" | "2fa",
  ): Promise<boolean> => {
    sentEmail = to;
    sentOtp = otp;
    sentType = purpose;
    return true;
  };

  let saved = false;
  const mockUser = {
    _id: new mongoose.Types.ObjectId(),
    email: "test@example.com",
    authProvider: "local",
    passwordResetCode: null as string | null,
    passwordResetCodeExpiresAt: null as Date | null,
    passwordResetAttempts: 3,
    save: async () => {
      saved = true;
    },
  };

  const originalFindOne = UserModel.findOne;
  UserModel.findOne = function (query: any) {
    if (query.email === "test@example.com") {
      return makeMockQuery(mockUser) as any;
    }
    return makeMockQuery(null) as any;
  };

  try {
    await authService.forgotPassword("test@example.com");

    assert.ok(saved);
    assert.equal(sentEmail, "test@example.com");
    assert.match(sentOtp ?? "", /^\d{6}$/);
    assert.equal(sentType, "forgot_password");
    assert.equal(mockUser.passwordResetCode, sha256(String(sentOtp)));
    assert.notEqual(mockUser.passwordResetCode, sentOtp);
    assert.equal(mockUser.passwordResetAttempts, 0);
    assert.ok(mockUser.passwordResetCodeExpiresAt);

    // Unknown emails resolve the same way, without sending anything.
    sentEmail = null;
    await authService.forgotPassword("nobody@example.com");
    assert.equal(sentEmail, null);
  } finally {
    EmailService.sendOtpEmail = originalSendOtpEmail;
    UserModel.findOne = originalFindOne;
  }
});

test("AuthService: verifyOtp resets the password and signs out every session", async () => {
  const mockUser = {
    _id: new mongoose.Types.ObjectId(),
    email: "test@example.com",
    password: "oldPassword",
    passwordResetCode: sha256("123456") as string | null,
    passwordResetCodeExpiresAt: new Date(Date.now() + 5000) as Date | null,
    passwordResetAttempts: 0,
    save: async () => undefined,
  };

  const originalFindOne = UserModel.findOne;
  UserModel.findOne = function () {
    return makeMockQuery(mockUser) as any;
  };
  let revokedFilter: any = null;
  const originalUpdateMany = DeviceSessionModel.updateMany;
  DeviceSessionModel.updateMany = function (filter: any) {
    revokedFilter = filter;
    return makeMockQuery({ modifiedCount: 2 }) as any;
  } as any;

  try {
    await assert.rejects(
      authService.verifyOtp("test@example.com", "123456", "short"),
      /at least 8 characters/,
    );

    await authService.verifyOtp(
      "test@example.com",
      "123456",
      "newSuperPassword123!",
    );
    assert.equal(mockUser.password, "newSuperPassword123!");
    assert.equal(mockUser.passwordResetCode, null);
    assert.equal(mockUser.passwordResetCodeExpiresAt, null);
    assert.equal(String(revokedFilter.userId), String(mockUser._id));
    assert.equal(revokedFilter.revokedAt, null);

    mockUser.passwordResetCode = sha256("123456");
    mockUser.passwordResetCodeExpiresAt = new Date(Date.now() - 5000);
    await assert.rejects(
      authService.verifyOtp("test@example.com", "123456", "longEnough1"),
      /expired or is invalid/,
    );
  } finally {
    UserModel.findOne = originalFindOne;
    DeviceSessionModel.updateMany = originalUpdateMany;
  }
});

test("AuthService: a reset code is invalidated after 5 wrong guesses", async () => {
  const mockUser = {
    _id: new mongoose.Types.ObjectId(),
    email: "test@example.com",
    passwordResetCode: sha256("123456") as string | null,
    passwordResetCodeExpiresAt: new Date(Date.now() + 60_000) as Date | null,
    passwordResetAttempts: 0,
    save: async () => undefined,
  };
  const originalFindOne = UserModel.findOne;
  UserModel.findOne = function () {
    return makeMockQuery(mockUser) as any;
  };

  try {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await assert.rejects(
        authService.verifyOtp("test@example.com", "000000", "longEnough1"),
        /Invalid OTP/,
      );
    }
    await assert.rejects(
      authService.verifyOtp("test@example.com", "000000", "longEnough1"),
      /Too many incorrect codes/,
    );
    assert.equal(mockUser.passwordResetCode, null);

    // Even the right code no longer works once the code is burned.
    await assert.rejects(
      authService.verifyOtp("test@example.com", "123456", "longEnough1"),
      /expired or is invalid/,
    );
  } finally {
    UserModel.findOne = originalFindOne;
  }
});

test("AuthService: toggle2FA updates user document settings", async () => {
  let saved = false;
  const mockUser = {
    _id: new mongoose.Types.ObjectId(),
    email: "test@example.com",
    syncApiKey: "key123",
    twoFactorEnabled: false,
    save: async () => {
      saved = true;
    },
  };

  const originalFindById = UserModel.findById;
  UserModel.findById = function (_id: any) {
    return makeMockQuery(mockUser) as any;
  };

  try {
    const result = await authService.toggle2FA(mockUser._id.toString(), true);
    assert.ok(saved);
    assert.equal(mockUser.twoFactorEnabled, true);
    assert.equal(result.twoFactorEnabled, true);
  } finally {
    UserModel.findById = originalFindById;
  }
});

test("AuthService: Google sign-in and code exchange use the same redirect URI", async () => {
  const authUrl = new URL(authService.getGoogleAuthorizationUrl("state"));
  const sentRedirect = authUrl.searchParams.get("redirect_uri");

  let exchangeArgs: any = null;
  const client = (authService as any).googleClient;
  const originalGetToken = client.getToken;
  client.getToken = async (args: unknown) => {
    exchangeArgs = args;
    return { tokens: {} };
  };

  try {
    await assert.rejects(
      authService.exchangeGoogleCode("code-123"),
      /ID token missing/,
    );
    assert.equal(exchangeArgs.code, "code-123");
    assert.equal(exchangeArgs.redirect_uri, sentRedirect);
    assert.equal(sentRedirect, authService.googleCallbackUri);
  } finally {
    client.getToken = originalGetToken;
  }
});
