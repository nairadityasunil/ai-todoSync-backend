import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export type SessionDeviceKind = "primary" | "companion";

export interface IDeviceSession {
  userId: Types.ObjectId | string;
  deviceId?: Types.ObjectId | string | null;
  deviceType: SessionDeviceKind;
  /** Set when the session belongs to an agent (e.g. ChatGPT Actions). */
  agentId?: Types.ObjectId | string | null;
  deviceName: string;
  companionDeviceType?: string | null;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  revokedAt?: Date | null;
  lastRotatedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IDeviceSessionDocument extends IDeviceSession, Document {}

const deviceSessionSchema = new Schema<IDeviceSessionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    deviceId: {
      type: Schema.Types.ObjectId,
      ref: "CompanionDevice",
      default: null,
    },
    deviceType: {
      type: String,
      enum: ["primary", "companion"],
      required: true,
    },
    deviceName: {
      type: String,
      required: true,
      trim: true,
    },
    companionDeviceType: {
      type: String,
      default: null,
      trim: true,
    },
    agentId: {
      type: Schema.Types.ObjectId,
      ref: "Agent",
      default: null,
    },
    refreshTokenHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    userAgent: {
      type: String,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    lastRotatedAt: {
      type: Date,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

deviceSessionSchema.index({ userId: 1, deviceType: 1, createdAt: -1 });
deviceSessionSchema.index({ deviceId: 1, revokedAt: 1 });
deviceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const DeviceSessionModel = model<IDeviceSessionDocument>(
  "DeviceSession",
  deviceSessionSchema,
);

export default DeviceSessionModel;
