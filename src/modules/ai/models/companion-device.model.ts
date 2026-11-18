import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export type CompanionDeviceStatus = "pending" | "active" | "revoked";

export interface ICompanionDevice {
  userId: Types.ObjectId | string;
  workspaceId?: Types.ObjectId | string | null;
  deviceName: string;
  deviceType: string;
  slot: number;
  status: CompanionDeviceStatus;
  revokedAt?: Date | null;
  /** The pairing lasts one month; then the device is removed and its tokens revoked. */
  expiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ICompanionDeviceDocument extends ICompanionDevice, Document {}

const companionDeviceSchema = new Schema<ICompanionDeviceDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      default: null,
      ref: "Workspace",
    },
    deviceName: {
      type: String,
      required: true,
      trim: true,
    },
    deviceType: {
      type: String,
      default: "companion",
      trim: true,
    },
    slot: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ["pending", "active", "revoked"],
      default: "active",
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

companionDeviceSchema.index({
  userId: 1,
  workspaceId: 1,
  status: 1,
  updatedAt: -1,
});
companionDeviceSchema.index({ status: 1, expiresAt: 1 });
companionDeviceSchema.index(
  { userId: 1, slot: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
  },
);

const CompanionDeviceModel = model<ICompanionDeviceDocument>(
  "CompanionDevice",
  companionDeviceSchema,
);

export default CompanionDeviceModel;
