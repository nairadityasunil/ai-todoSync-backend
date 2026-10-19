import crypto from "crypto";
import mongoose from "mongoose";
import jwt, { JwtPayload } from "jsonwebtoken";
import { OAuth2Client, TokenPayload } from "google-auth-library";

import env from "../../../config/env.js";
import { EmailService } from "../../../shared/services/email.service.js";
import {
  countActiveCompanionDevices,
  createCompanionDevice,
  findCompanionDeviceByIdForUser,
  listCompanionDevicesByUser,
  revokeCompanionDevice,
  updateCompanionDevice,
} from "../../../modules/ai/repositories/companion-device.repository.js";
import {
  consumeCompanionKey,
  createCompanionKey,
  deleteCompanionKeyById,
  deleteUsedCompanionKeys,
  listUnusedCompanionKeysByUser,
  updateCompanionKeyById,
} from "../../../modules/ai/repositories/companion-key.repository.js";
import {
  CreateUserPayload,
  createUser,
  findUserByEmail,
  findUserByGoogleId,
  findUserById,
} from "../../../modules/auth/repositories/auth.repository.js";
import {
  createDeviceSession,
  findActiveDeviceSessionById,
  revokeDeviceSession,
  revokeDeviceSessionsByDeviceId,
  revokeSessionsByUserAndDevice,
  updateDeviceSessionRefreshToken,
} from "../../../modules/auth/repositories/device-session.repository.js";
import type { ICompanionDeviceDocument } from "../../ai/models/companion-device.model.js";
import type {
  IDeviceSessionDocument,
  SessionDeviceKind,
} from "../../../modules/auth/models/device-session.model.js";
import type { IUserDocument } from "../models/user.model.js";
import DeviceSessionModel from "../models/device-session.model.js";
import type {
  AuthProfile,
  AuthResult,
  SessionDeviceContext,
} from "../../../types/auth.js";

interface LoginCredentials {
  email: string;
  password: string;
}

interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | null;
}

interface DeviceMetadataInput {
  deviceName?: string | null;
  deviceType?: string | null;
  userAgent?: string | null;
}

interface CreateCompanionKeyInput {
  deviceName?: string | null;
  deviceType?: string | null;
}

interface CompanionKeyLoginInput extends DeviceMetadataInput {
  key: string;
}

interface UpdateCompanionDeviceInput {
  deviceName?: string | null;
  deviceType?: string | null;
}

interface TokenClaims extends JwtPayload {
  userId?: string;
  sessionId?: string;
  deviceId?: string | null;
  deviceType?: SessionDeviceKind;
  tokenType?: "access" | "refresh";
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

interface SessionIssueResult extends IssuedTokens {
  session: IDeviceSessionDocument;
  companionDevice: ICompanionDeviceDocument | null;
}

interface DeviceDescriptor {
  deviceId: string | null;
  deviceType: SessionDeviceKind;
  deviceName: string;
  companionDeviceType: string | null;
  userAgent: string | null;
}

export interface CompanionDeviceSummary {
  id: string;
  deviceName: string;
  deviceType: string;
  status: "active" | "revoked" | "pending";
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
  revokedAt: Date | null | undefined;
}

export interface CompanionKeyResult {
  key: string;
  maxCompanionDevices: number;
  activeCompanionDevices: number;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class AuthService {
  private readonly googleScopes = ["openid", "email", "profile"];
  private readonly googleClient = new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  public async register(
    payload: CreateUserPayload,
    metadata: DeviceMetadataInput = {},
  ): Promise<AuthResult> {
    if (payload.email == null || payload.password == null) {
      throw new HttpError(400, "Email and password are required");
    }
    this.assertPasswordStrength(payload.password);

    const existingUser = await findUserByEmail(payload.email);
    if (existingUser != null) {
      throw new HttpError(409, "Email is already in use");
    }

    const user = await createUser(payload);

    try {
      const workspaceService = (
        await import("../../workspace/services/workspace.service.js")
      ).default;
      await workspaceService.getOrCreateDefaultWorkspace(user._id.toString());

      const invitationService = (
        await import("../../workspace/services/invitation.service.js")
      ).default;
      await invitationService.handlePostRegistrationInvitations(
        user._id.toString(),
        user.email,
      );
    } catch (err) {
      console.error(
        "Failed to auto-process workspace initialization on registration",
        err,
      );
    }

    return this.issuePrimaryAuthResult(user, metadata);
  }

  public async login(
    credentials: LoginCredentials,
    metadata: DeviceMetadataInput = {},
  ): Promise<AuthResult | { require2fa: true; email: string }> {
    if (credentials.email == null || credentials.password == null) {
      throw new HttpError(400, "Email and password are required");
    }

    const user = await findUserByEmail(credentials.email);

    if (user == null) {
      throw new HttpError(401, "Invalid credentials");
    }

    // Accounts created through Google have no password; accounts that
    // linked Google later keep theirs and can still use it.
    if (!user.password) {
      throw new HttpError(
        401,
        "This account is registered via Google. Please sign in with Google.",
      );
    }

    const isMatch = await user.comparePassword(credentials.password);

    if (isMatch === false) {
      throw new HttpError(401, "Invalid credentials");
    }

    if (user.twoFactorEnabled) {
      const otp = this.generateOtp();
      user.twoFactorCode = this.hashSecret(otp);
      user.twoFactorCodeExpiresAt = new Date(Date.now() + OTP_TTL_MS);
      user.twoFactorAttempts = 0;
      await user.save();

      await EmailService.sendOtpEmail(user.email, otp, "2fa");
      return { require2fa: true, email: user.email };
    }

    return this.issuePrimaryAuthResult(user, metadata);
  }

  public async verify2FA(
    email: string,
    code: string,
    metadata: DeviceMetadataInput = {},
  ): Promise<AuthResult> {
    if (!email || !code) {
      throw new HttpError(400, "Email and code are required");
    }

    const user = await findUserByEmail(email);
    if (
      user == null ||
      !user.twoFactorCode ||
      !user.twoFactorCodeExpiresAt ||
      user.twoFactorCodeExpiresAt.getTime() < Date.now()
    ) {
      throw new HttpError(400, "2FA code has expired or is invalid");
    }

    if (!this.safeEqual(this.hashSecret(String(code)), user.twoFactorCode)) {
      user.twoFactorAttempts = (user.twoFactorAttempts ?? 0) + 1;
      if (user.twoFactorAttempts >= MAX_OTP_ATTEMPTS) {
        user.twoFactorCode = null;
        user.twoFactorCodeExpiresAt = null;
        await user.save();
        throw new HttpError(
          429,
          "Too many incorrect codes. Sign in again to get a new code.",
        );
      }
      await user.save();
      throw new HttpError(400, "Invalid 2FA code");
    }

    user.twoFactorCode = null;
    user.twoFactorCodeExpiresAt = null;
    user.twoFactorAttempts = 0;
    await user.save();

    return this.issuePrimaryAuthResult(user, metadata);
  }

  public async forgotPassword(email: string): Promise<void> {
    if (!email) {
      throw new HttpError(400, "Email is required");
    }

    const user = await findUserByEmail(email);
    // Respond the same way whether or not the account exists, so this
    // endpoint cannot be used to discover registered emails.
    if (user == null || user.authProvider === "google") {
      return;
    }

    const otp = this.generateOtp();
    user.passwordResetCode = this.hashSecret(otp);
    user.passwordResetCodeExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    user.passwordResetAttempts = 0;
    await user.save();

    await EmailService.sendOtpEmail(user.email, otp, "forgot_password");
  }

  public async verifyOtp(
    email: string,
    otp: string,
    newPassword: string,
  ): Promise<void> {
    if (!email || !otp || !newPassword) {
      throw new HttpError(400, "Email, OTP and new password are required");
    }
    this.assertPasswordStrength(newPassword);

    const user = await findUserByEmail(email);
    if (
      user == null ||
      !user.passwordResetCode ||
      !user.passwordResetCodeExpiresAt ||
      user.passwordResetCodeExpiresAt.getTime() < Date.now()
    ) {
      throw new HttpError(400, "OTP has expired or is invalid");
    }

    if (!this.safeEqual(this.hashSecret(String(otp)), user.passwordResetCode)) {
      user.passwordResetAttempts = (user.passwordResetAttempts ?? 0) + 1;
      if (user.passwordResetAttempts >= MAX_OTP_ATTEMPTS) {
        user.passwordResetCode = null;
        user.passwordResetCodeExpiresAt = null;
        await user.save();
        throw new HttpError(
          429,
          "Too many incorrect codes. Request a new code to continue.",
        );
      }
      await user.save();
      throw new HttpError(400, "Invalid OTP");
    }

    user.password = newPassword;
    user.passwordResetCode = null;
    user.passwordResetCodeExpiresAt = null;
    user.passwordResetAttempts = 0;
    await user.save();

    // A reset means the old password may be compromised: sign out everywhere.
    await DeviceSessionModel.updateMany(
      { userId: user._id, revokedAt: null },
      { revokedAt: new Date() },
    ).exec();
  }

  public async toggle2FA(
    userId: string,
    enabled: boolean,
  ): Promise<AuthProfile> {
    const user = await findUserById(userId);
    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    user.twoFactorEnabled = enabled;
    await user.save();

    return this.buildProfile(user);
  }

  public async refreshTokens(refreshToken: string): Promise<AuthResult> {
    if (!refreshToken) {
      throw new HttpError(400, "Refresh token is required");
    }

    const claims = this.verifyToken(refreshToken, "refresh");
    const userId = claims.userId;
    const sessionId = claims.sessionId;

    if (!userId || !sessionId) {
      throw new HttpError(401, "Invalid refresh token");
    }

    const user = await findUserById(userId);

    if (user == null) {
      throw new HttpError(401, "Invalid refresh token");
    }

    const now = new Date();
    const session = await findActiveDeviceSessionById(sessionId, now);

    if (session == null) {
      throw new HttpError(401, "Refresh session is no longer active");
    }

    const incomingHash = this.hashSecret(refreshToken);
    const storedHash = session.refreshTokenHash;

    if (!this.safeEqual(incomingHash, storedHash)) {
      await this.handleRefreshReuse(session);
      throw new HttpError(401, "Refresh token reuse detected");
    }

    const companionDevice = await this.resolveCompanionDeviceForSession(
      userId,
      session,
    );
    const refreshed = await this.rotateSessionTokens(
      session,
      companionDevice,
      now,
    );

    return this.buildAuthResult(user, refreshed, companionDevice);
  }

  public async getCurrentUser(userId: string): Promise<AuthProfile> {
    const user = await findUserById(userId);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    return this.buildProfile(user);
  }

  public async regenerateSyncKey(userId: string): Promise<string> {
    const user = await findUserById(userId);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    const syncApiKey = user.regenerateSyncApiKey();
    await user.save();

    return syncApiKey;
  }

  public async updateProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      openaiApiKey?: string;
      anthropicApiKey?: string;
      geminiApiKey?: string;
    },
  ): Promise<AuthProfile> {
    const user = await findUserById(userId);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    if (data.firstName !== undefined) user.firstName = data.firstName;
    if (data.lastName !== undefined) user.lastName = data.lastName;

    if (data.openaiApiKey !== undefined) {
      if (data.openaiApiKey === "") {
        user.set("openaiApiKey", undefined);
      } else if (data.openaiApiKey !== "••••••••") {
        user.openaiApiKey = data.openaiApiKey;
      }
    }

    if (data.anthropicApiKey !== undefined) {
      if (data.anthropicApiKey === "") {
        user.set("anthropicApiKey", undefined);
      } else if (data.anthropicApiKey !== "••••••••") {
        user.anthropicApiKey = data.anthropicApiKey;
      }
    }

    if (data.geminiApiKey !== undefined) {
      if (data.geminiApiKey === "") {
        user.set("geminiApiKey", undefined);
      } else if (data.geminiApiKey !== "••••••••") {
        user.geminiApiKey = data.geminiApiKey;
      }
    }

    // Compute display name
    const parts = [user.firstName, user.lastName].filter(Boolean);
    if (parts.length > 0) {
      user.name = parts.join(" ");
    }

    await user.save();
    return this.buildProfile(user);
  }

  public async createCompanionAccessKey(
    userId: string,
    input: CreateCompanionKeyInput,
  ): Promise<CompanionKeyResult> {
    const user = await findUserById(userId);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    const activeCompanionDevices = await countActiveCompanionDevices(userId);

    if (activeCompanionDevices >= env.MAX_COMPANION_DEVICES) {
      throw new HttpError(409, "Maximum active companion devices reached");
    }

    await deleteUsedCompanionKeys(userId);
    const rawKey = crypto.randomBytes(32).toString("hex");

    await createCompanionKey({
      userId,
      keyHash: this.hashSecret(rawKey),
      deviceName: this.normalizeOptionalText(input.deviceName),
      deviceType: this.normalizeOptionalText(input.deviceType),
    });

    return {
      key: rawKey,
      maxCompanionDevices: env.MAX_COMPANION_DEVICES,
      activeCompanionDevices,
    };
  }

  public async loginCompanionDevice(
    input: CompanionKeyLoginInput,
  ): Promise<AuthResult> {
    if (!input.key) {
      throw new HttpError(400, "Companion key is required");
    }

    const now = new Date();
    const keyDocument = await consumeCompanionKey(
      this.hashSecret(input.key),
      now,
    );

    if (keyDocument == null) {
      throw new HttpError(401, "Companion key is invalid or already used");
    }

    const user = await findUserById(keyDocument.userId.toString());

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    const activeCount = await countActiveCompanionDevices(user._id.toString());

    if (activeCount >= env.MAX_COMPANION_DEVICES) {
      throw new HttpError(409, "Maximum active companion devices reached");
    }

    const companionDevice = await this.createActiveCompanionDevice(
      user._id.toString(),
      {
        deviceName: input.deviceName ?? keyDocument.deviceName,
        deviceType: input.deviceType ?? keyDocument.deviceType,
      },
    );

    const issued = await this.issueSessionForDevice(user, {
      deviceId: companionDevice._id.toString(),
      deviceType: "companion",
      deviceName: companionDevice.deviceName,
      companionDeviceType: companionDevice.deviceType,
      userAgent: this.normalizeOptionalText(input.userAgent),
    });

    return this.buildAuthResult(user, issued, companionDevice);
  }

  public async loginCompanionDeviceWithQr(input: {
    userId: string;
    workspaceId?: string | null;
    deviceName: string;
    deviceType: string;
    userAgent?: string | null;
  }): Promise<AuthResult> {
    const user = await findUserById(input.userId);

    if (user == null) {
      throw new HttpError(404, "User not found");
    }

    const activeCount = await countActiveCompanionDevices(
      user._id.toString(),
      input.workspaceId,
    );

    if (activeCount >= env.MAX_COMPANION_DEVICES) {
      throw new HttpError(409, "Maximum active companion devices reached");
    }

    const companionDevice = await this.createActiveCompanionDevice(
      user._id.toString(),
      {
        deviceName: input.deviceName,
        deviceType: input.deviceType,
      },
    );

    const issued = await this.issueSessionForDevice(user, {
      deviceId: companionDevice._id.toString(),
      deviceType: "companion",
      deviceName: companionDevice.deviceName,
      companionDeviceType: companionDevice.deviceType,
      userAgent: this.normalizeOptionalText(input.userAgent),
    });

    return this.buildAuthResult(user, issued, companionDevice);
  }

  public async listCompanionDevices(
    userId: string,
  ): Promise<CompanionDeviceSummary[]> {
    const [devices, pendingKeys] = await Promise.all([
      listCompanionDevicesByUser(userId),
      listUnusedCompanionKeysByUser(userId),
    ]);

    const activeList: CompanionDeviceSummary[] = devices.map((device) => ({
      id: device._id.toString(),
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      status: device.status,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
      revokedAt: device.revokedAt,
    }));

    const pendingList: CompanionDeviceSummary[] = pendingKeys.map((key) => ({
      id: key._id.toString(),
      deviceName: key.deviceName || "Unregistered Device",
      deviceType: key.deviceType || "companion",
      status: "pending",
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      revokedAt: null,
    }));

    // Show pending keys first, then active devices
    return [...pendingList, ...activeList];
  }

  public async updateCompanionDevice(
    userId: string,
    deviceId: string,
    input: UpdateCompanionDeviceInput,
  ): Promise<CompanionDeviceSummary> {
    const updates: Partial<{ deviceName: string; deviceType: string }> = {};

    if (input.deviceName !== undefined) {
      const deviceName = this.normalizeOptionalText(input.deviceName);

      if (deviceName == null) {
        throw new HttpError(400, "Device name cannot be empty");
      }

      updates.deviceName = deviceName;
    }

    if (input.deviceType !== undefined) {
      const deviceType = this.normalizeOptionalText(input.deviceType);

      if (deviceType == null) {
        throw new HttpError(400, "Device type cannot be empty");
      }

      updates.deviceType = deviceType;
    }

    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, "At least one device field is required");
    }

    if (!mongoose.Types.ObjectId.isValid(deviceId)) {
      throw new HttpError(
        404,
        "Companion device or key not found (Invalid ID)",
      );
    }

    const updated = await updateCompanionDevice(userId, deviceId, updates);

    if (updated != null) {
      return {
        id: updated._id.toString(),
        deviceName: updated.deviceName,
        deviceType: updated.deviceType,
        status: updated.status,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        revokedAt: updated.revokedAt,
      };
    }

    // Try updating a pending key if device not found
    const updatedKey = await updateCompanionKeyById(userId, deviceId, updates);

    if (updatedKey == null) {
      throw new HttpError(404, "Companion device or pending key not found");
    }

    return {
      id: updatedKey._id.toString(),
      deviceName: updatedKey.deviceName || "Unregistered Device",
      deviceType: updatedKey.deviceType || "companion",
      status: "pending",
      createdAt: updatedKey.createdAt,
      updatedAt: updatedKey.updatedAt,
      revokedAt: null,
    };
  }

  public async revokeCompanionDevice(
    userId: string,
    deviceId: string,
  ): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(deviceId)) {
      // If it's not a valid ObjectId (e.g. leftover dummy ID), just 404
      throw new HttpError(404, "Device or key not found (Invalid ID)");
    }

    const revokedAt = new Date();
    const device = await revokeCompanionDevice(userId, deviceId, revokedAt);

    if (device != null) {
      await revokeDeviceSessionsByDeviceId(deviceId, revokedAt);
      return;
    }

    // If no active device, check if it's a pending key to delete
    const deletedKey = await deleteCompanionKeyById(userId, deviceId);

    if (deletedKey == null) {
      const existing = await findCompanionDeviceByIdForUser(userId, deviceId);

      if (existing == null) {
        throw new HttpError(404, "Companion device or pending key not found");
      }

      if (existing.status === "revoked") {
        return;
      }
    }
  }

  /**
   * The OAuth callback URL sent to Google. It must be listed under
   * "Authorized redirect URIs" for the OAuth client in Google Cloud Console.
   */
  public get googleCallbackUri(): string {
    return `${env.BACKEND_URL}/api/auth/google/callback`;
  }

  public getGoogleAuthorizationUrl(state?: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.googleCallbackUri);
    url.searchParams.set("scope", this.googleScopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");

    if (state) {
      url.searchParams.set("state", state);
    }

    return url.toString();
  }

  public async exchangeGoogleCode(
    code: string,
    metadata: DeviceMetadataInput = {},
  ): Promise<AuthResult> {
    if (!code) {
      throw new HttpError(400, "Google authorization code is required");
    }

    // Google rejects the exchange unless redirect_uri matches the one used
    // to start sign-in exactly, so both use googleCallbackUri.
    const { tokens } = await this.googleClient.getToken({
      code,
      redirect_uri: this.googleCallbackUri,
    });

    if (!tokens.id_token) {
      throw new HttpError(
        401,
        "Google ID token missing from authorization response",
      );
    }

    return this.authenticateWithGoogle(tokens.id_token, metadata);
  }

  public verifyAccessToken(token: string): TokenClaims {
    return this.verifyToken(token, "access");
  }

  private async authenticateWithGoogle(
    idToken: string,
    metadata: DeviceMetadataInput = {},
  ): Promise<AuthResult> {
    const googleProfile = await this.verifyGoogleIdToken(idToken);
    const user = await this.findOrCreateGoogleUser(googleProfile);

    return this.issuePrimaryAuthResult(user, metadata);
  }

  private async issuePrimaryAuthResult(
    user: IUserDocument,
    metadata: DeviceMetadataInput,
  ): Promise<AuthResult> {
    const issued = await this.issueSessionForDevice(user, {
      deviceId: null,
      deviceType: "primary",
      deviceName: this.resolvePrimaryDeviceName(metadata.deviceName),
      companionDeviceType: this.normalizeOptionalText(metadata.deviceType),
      userAgent: this.normalizeOptionalText(metadata.userAgent),
    });

    return this.buildAuthResult(user, issued, null);
  }

  private async issueSessionForDevice(
    user: IUserDocument,
    descriptor: DeviceDescriptor,
  ): Promise<SessionIssueResult> {
    const placeholderHash = this.hashSecret(
      crypto.randomBytes(32).toString("hex"),
    );
    const session = await createDeviceSession({
      userId: user._id.toString(),
      deviceId: descriptor.deviceId,
      deviceType: descriptor.deviceType,
      deviceName: descriptor.deviceName,
      companionDeviceType: descriptor.companionDeviceType,
      refreshTokenHash: placeholderHash,
      expiresAt: new Date(Date.now() + this.refreshTokenExpiresInMs()),
      userAgent: descriptor.userAgent,
      revokedAt: null,
      lastRotatedAt: null,
      lastUsedAt: new Date(),
    });

    const tokens = this.createTokenPair({
      userId: user._id.toString(),
      sessionId: session._id.toString(),
      deviceId: descriptor.deviceId,
      deviceType: descriptor.deviceType,
    });

    const refreshedSession = await updateDeviceSessionRefreshToken(
      session._id.toString(),
      this.hashSecret(tokens.refreshToken),
      new Date(Date.now() + this.refreshTokenExpiresInMs()),
      new Date(),
    );

    if (refreshedSession == null) {
      throw new HttpError(500, "Unable to create device session");
    }

    return {
      ...tokens,
      session: refreshedSession,
      companionDevice:
        descriptor.deviceType === "companion"
          ? await findCompanionDeviceByIdForUser(
              user._id.toString(),
              descriptor.deviceId ?? "",
            )
          : null,
    };
  }

  private async rotateSessionTokens(
    session: IDeviceSessionDocument,
    companionDevice: ICompanionDeviceDocument | null,
    now: Date,
  ): Promise<SessionIssueResult> {
    const tokens = this.createTokenPair({
      userId: session.userId.toString(),
      sessionId: session._id.toString(),
      deviceId: session.deviceId?.toString() ?? null,
      deviceType: session.deviceType,
    });

    const refreshedSession = await updateDeviceSessionRefreshToken(
      session._id.toString(),
      this.hashSecret(tokens.refreshToken),
      new Date(now.getTime() + this.refreshTokenExpiresInMs()),
      now,
    );

    if (refreshedSession == null) {
      throw new HttpError(401, "Session is no longer active");
    }

    return {
      ...tokens,
      session: refreshedSession,
      companionDevice,
    };
  }

  private async resolveCompanionDeviceForSession(
    userId: string,
    session: IDeviceSessionDocument,
  ): Promise<ICompanionDeviceDocument | null> {
    if (session.deviceType !== "companion" || session.deviceId == null) {
      return null;
    }

    const companionDevice = await findCompanionDeviceByIdForUser(
      userId,
      session.deviceId.toString(),
    );

    if (companionDevice == null || companionDevice.status !== "active") {
      throw new HttpError(401, "Companion device is no longer active");
    }

    return companionDevice;
  }

  private async handleRefreshReuse(
    session: IDeviceSessionDocument,
  ): Promise<void> {
    const revokedAt = new Date();

    await revokeDeviceSession(session._id.toString(), revokedAt);

    if (session.deviceType === "companion" && session.deviceId != null) {
      await revokeDeviceSessionsByDeviceId(
        session.deviceId.toString(),
        revokedAt,
      );
      return;
    }

    await revokeSessionsByUserAndDevice(
      session.userId.toString(),
      null,
      session.deviceType,
      revokedAt,
    );
  }

  private createTokenPair(payload: {
    userId: string;
    sessionId: string;
    deviceId: string | null;
    deviceType: SessionDeviceKind;
  }): IssuedTokens {
    const accessToken = jwt.sign(
      {
        userId: payload.userId,
        sessionId: payload.sessionId,
        deviceId: payload.deviceId,
        deviceType: payload.deviceType,
        tokenType: "access",
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] },
    );

    const refreshToken = jwt.sign(
      {
        userId: payload.userId,
        sessionId: payload.sessionId,
        deviceId: payload.deviceId,
        deviceType: payload.deviceType,
        tokenType: "refresh",
      },
      env.JWT_SECRET,
      {
        expiresIn: env.REFRESH_TOKEN_EXPIRES_IN as jwt.SignOptions["expiresIn"],
      },
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: this.accessTokenExpiresInSeconds(),
      refreshTokenExpiresIn: this.refreshTokenExpiresInSeconds(),
    };
  }

  private verifyToken(
    token: string,
    expectedType: "access" | "refresh",
  ): TokenClaims {
    try {
      const claims = jwt.verify(token, env.JWT_SECRET) as TokenClaims;

      if (claims.tokenType !== expectedType) {
        throw new HttpError(401, `Invalid ${expectedType} token`);
      }

      return claims;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(401, `Invalid ${expectedType} token`);
    }
  }

  private async createActiveCompanionDevice(
    userId: string,
    input: { deviceName?: string | null; deviceType?: string | null },
  ): Promise<ICompanionDeviceDocument> {
    const normalizedType =
      this.normalizeOptionalText(input.deviceType) ?? "companion";

    for (let slot = 1; slot <= env.MAX_COMPANION_DEVICES; slot += 1) {
      try {
        return await createCompanionDevice({
          userId,
          slot,
          deviceName:
            this.normalizeOptionalText(input.deviceName) ??
            `Companion Device ${slot}`,
          deviceType: normalizedType,
          status: "active",
          revokedAt: null,
        });
      } catch (error) {
        if (this.isDuplicateKeyError(error)) {
          continue;
        }

        throw error;
      }
    }

    throw new HttpError(409, "Maximum active companion devices reached");
  }

  private buildProfile(user: IUserDocument): AuthProfile {
    return {
      id: user._id.toString(),
      email: user.email,
      syncApiKey: user.syncApiKey,
      name: user.name ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      authProvider: user.authProvider,
      openaiApiKeyConfigured: !!user.openaiApiKey,
      anthropicApiKeyConfigured: !!user.anthropicApiKey,
      geminiApiKeyConfigured: !!user.geminiApiKey,
      twoFactorEnabled: user.twoFactorEnabled,
    };
  }

  private buildAuthResult(
    user: IUserDocument,
    sessionResult: SessionIssueResult,
    companionDevice: ICompanionDeviceDocument | null,
  ): AuthResult {
    return {
      token: sessionResult.accessToken,
      accessToken: sessionResult.accessToken,
      refreshToken: sessionResult.refreshToken,
      accessTokenExpiresIn: sessionResult.accessTokenExpiresIn,
      refreshTokenExpiresIn: sessionResult.refreshTokenExpiresIn,
      syncApiKey: user.syncApiKey,
      user: this.buildProfile(user),
      session: this.buildSessionContext(sessionResult.session, companionDevice),
    };
  }

  private buildSessionContext(
    session: IDeviceSessionDocument,
    companionDevice: ICompanionDeviceDocument | null,
  ): SessionDeviceContext {
    return {
      sessionId: session._id.toString(),
      deviceId: session.deviceId?.toString() ?? null,
      deviceType: session.deviceType,
      deviceName: companionDevice?.deviceName ?? session.deviceName,
      companionDeviceType:
        companionDevice?.deviceType ?? session.companionDeviceType ?? null,
      authMethod: "access_token",
    };
  }

  private async findOrCreateGoogleUser(
    profile: GoogleProfile,
  ): Promise<IUserDocument> {
    let user = await findUserByGoogleId(profile.googleId);

    if (user == null) {
      user = await findUserByEmail(profile.email);
    }

    if (user == null) {
      const newUser = await createUser({
        email: profile.email,
        password: null,
        authProvider: "google",
        googleId: profile.googleId,
        name: profile.name,
      });

      try {
        const workspaceService = (
          await import("../../workspace/services/workspace.service.js")
        ).default;
        await workspaceService.getOrCreateDefaultWorkspace(
          newUser._id.toString(),
        );

        const invitationService = (
          await import("../../workspace/services/invitation.service.js")
        ).default;
        await invitationService.handlePostRegistrationInvitations(
          newUser._id.toString(),
          newUser.email,
        );
      } catch (err) {
        console.error(
          "Failed to auto-process workspace initialization on Google registration",
          err,
        );
      }

      return newUser;
    }

    let hasChanges = false;

    if (user.googleId !== profile.googleId) {
      user.googleId = profile.googleId;
      hasChanges = true;
    }

    if (user.name !== profile.name) {
      user.name = profile.name;
      hasChanges = true;
    }

    if (user.email !== profile.email) {
      user.email = profile.email;
      hasChanges = true;
    }

    // Linking Google must not lock out an account's existing password.
    if (user.authProvider !== "google" && !user.password) {
      user.authProvider = "google";
      hasChanges = true;
    }

    if (hasChanges) {
      await user.save();
    }

    return user;
  }

  private async verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (payload == null) {
      throw new HttpError(401, "Unable to validate Google credential");
    }

    return this.buildGoogleProfile(payload);
  }

  private buildGoogleProfile(payload: TokenPayload): GoogleProfile {
    if (!payload.sub || !payload.email || payload.email_verified !== true) {
      throw new HttpError(401, "Google account email could not be verified");
    }

    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name ?? null,
    };
  }

  private normalizeOptionalText(
    value: string | null | undefined,
  ): string | null {
    if (value == null) {
      return null;
    }

    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  private resolvePrimaryDeviceName(deviceName?: string | null): string {
    return this.normalizeOptionalText(deviceName) ?? "Primary Device";
  }

  private generateOtp(): string {
    return crypto.randomInt(100000, 1000000).toString();
  }

  private assertPasswordStrength(password: string): void {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(
        400,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
  }

  private hashSecret(secret: string): string {
    return crypto.createHash("sha256").update(secret).digest("hex");
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  private accessTokenExpiresInSeconds(): number {
    return this.parseDurationToSeconds(env.JWT_EXPIRES_IN);
  }

  private refreshTokenExpiresInSeconds(): number {
    return this.parseDurationToSeconds(env.REFRESH_TOKEN_EXPIRES_IN);
  }

  private refreshTokenExpiresInMs(): number {
    return this.refreshTokenExpiresInSeconds() * 1000;
  }

  private parseDurationToSeconds(value: string): number {
    const normalized = value.trim();

    if (/^\d+$/.test(normalized)) {
      return Number(normalized);
    }

    const match = normalized.match(/^(\d+)([smhd])$/i);

    if (!match) {
      throw new Error(`Unsupported duration format: ${value}`);
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplierMap: Record<string, number> = {
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 60 * 60 * 24,
    };

    return amount * multiplierMap[unit];
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }
}

const authService = new AuthService();

export { HttpError };
export type {
  CreateCompanionKeyInput,
  DeviceMetadataInput,
  LoginCredentials,
  UpdateCompanionDeviceInput,
};
export default authService;
