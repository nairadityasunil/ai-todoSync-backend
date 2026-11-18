import bcrypt from "bcryptjs";
import type { Document } from "mongoose";
import { Schema, model } from "mongoose";
import { clearAuthCache } from "../../../middleware/auth-cache.js";
import { encrypt, decrypt } from "../../../utils/encryption.js";

export interface IUser {
  email: string;
  password: string | null;
  /** Legacy plain-text Sync key; moved to a hashed agent key on first use. */
  syncApiKey?: string | null;
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
  twoFactorAttempts?: number;
  passwordResetAttempts?: number;
  /** Last password change or reset (agent session risk). */
  passwordChangedAt?: Date | null;
  /** Platform role: super admins run the admin panel. Also granted by the SUPER_ADMIN_EMAILS setting. */
  platformRole?: "user" | "super_admin";
  /** Suspended people cannot sign in or use the API; deleted accounts are anonymised. */
  accountStatus?: "active" | "suspended" | "deleted";
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUserDocument extends IUser, Document {
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUserDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      default: null,
    },
    syncApiKey: {
      type: String,
      default: null,
      index: { sparse: true },
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      required: true,
      default: "local",
    },
    googleId: {
      type: String,
      default: null,
    },
    name: {
      type: String,
      trim: true,
      default: null,
    },
    firstName: {
      type: String,
      trim: true,
      default: null,
    },
    lastName: {
      type: String,
      trim: true,
      default: null,
    },
    openaiApiKey: {
      type: String,
      default: null,
      get: (v: string) => (v ? decrypt(v) : v),
      set: (v: string) => (v ? encrypt(v) : v),
    },
    anthropicApiKey: {
      type: String,
      default: null,
      get: (v: string) => (v ? decrypt(v) : v),
      set: (v: string) => (v ? encrypt(v) : v),
    },
    geminiApiKey: {
      type: String,
      default: null,
      get: (v: string) => (v ? decrypt(v) : v),
      set: (v: string) => (v ? encrypt(v) : v),
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorCode: {
      type: String,
      default: null,
    },
    twoFactorCodeExpiresAt: {
      type: Date,
      default: null,
    },
    passwordResetCode: {
      type: String,
      default: null,
    },
    passwordResetCodeExpiresAt: {
      type: Date,
      default: null,
    },
    twoFactorAttempts: {
      type: Number,
      default: 0,
    },
    passwordResetAttempts: {
      type: Number,
      default: 0,
    },
    passwordChangedAt: { type: Date, default: null },
    platformRole: {
      type: String,
      enum: ["user", "super_admin"],
      default: "user",
    },
    accountStatus: {
      type: String,
      enum: ["active", "suspended", "deleted"],
      default: "active",
      index: true,
    },
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  },
);

// Newest first in the admin people list, and platform admins.
userSchema.index({ createdAt: -1 });
userSchema.index({ platformRole: 1 }, { sparse: true });

// Any change to a person invalidates the short auth memory (see middleware/auth-cache.ts).
for (const op of [
  "save",
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndDelete",
  "deleteOne",
  "deleteMany",
  "replaceOne",
] as const) {
  userSchema.post(op as never, clearAuthCache as never);
}

userSchema.pre<IUserDocument>("save", async function () {
  if (!this.isModified("password") || this.password == null) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  if (!this.isNew) this.passwordChangedAt = new Date();
});

userSchema.methods.comparePassword = async function (candidate: string) {
  if (this.password == null) {
    return false;
  }

  return bcrypt.compare(candidate, this.password);
};

const UserModel = model<IUserDocument>("User", userSchema);

export default UserModel;
