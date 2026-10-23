import type { Types } from "mongoose";

export interface IUser {
  email: string;
  password: string | null;
  syncApiKey: string | null;
  authProvider: "local" | "google";
  googleId?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  twoFactorEnabled?: boolean;
  twoFactorCode?: string | null;
  twoFactorCodeExpiresAt?: Date | null;
  passwordResetCode?: string | null;
  passwordResetCodeExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IApiKey {
  workspaceId: Types.ObjectId | string;
  name: string;
  keyHash: string;
  maskedKey: string;
  createdBy: Types.ObjectId | string;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IDeviceSession {
  userId: Types.ObjectId | string;
  deviceFingerprint: string;
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
  lastActiveAt: Date;
  isRevoked: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
