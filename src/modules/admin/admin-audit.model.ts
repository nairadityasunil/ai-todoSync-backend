import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

/** Every change a platform admin makes, who made it, and to whom. */
export interface IAdminAudit {
  actorId: Types.ObjectId;
  actorEmail: string;
  action: string;
  targetType: "user" | "workspace" | "platform";
  targetId?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  createdAt?: Date;
}

export interface IAdminAuditDocument extends IAdminAudit, Document {}

const schema = new Schema<IAdminAuditDocument>(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true, index: true },
    targetType: {
      type: String,
      enum: ["user", "workspace", "platform"],
      required: true,
    },
    targetId: { type: String, default: null, index: true },
    targetLabel: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ createdAt: -1 });

export default model<IAdminAuditDocument>("AdminAudit", schema);
