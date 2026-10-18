import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { Document } from "mongoose";
import { Schema, model } from "mongoose";
import { encrypt, decrypt } from "../../../utils/encryption.js";

export interface IUser {
  email: string;
  password: string | null;
  syncApiKey: string;
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
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUserDocument extends IUser, Document {
  comparePassword(candidate: string): Promise<boolean>;
  regenerateSyncApiKey(): string;
}

const generateSyncApiKey = () => randomBytes(32).toString("hex");

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
      required: true,
      default: generateSyncApiKey,
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
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  },
);

userSchema.pre<IUserDocument>("save", async function () {
  if (!this.isModified("password") || this.password == null) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidate: string) {
  if (this.password == null) {
    return false;
  }

  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.regenerateSyncApiKey = function () {
  this.syncApiKey = generateSyncApiKey();
  return this.syncApiKey;
};

const UserModel = model<IUserDocument>("User", userSchema);

export default UserModel;
