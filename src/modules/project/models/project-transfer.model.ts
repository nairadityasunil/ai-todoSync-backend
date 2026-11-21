import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export type ProjectTransferStatus =
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "CANCELLED";

export interface IProjectTransfer {
  projectId: Types.ObjectId | string;
  currentOwnerId: Types.ObjectId | string;
  targetUserId?: Types.ObjectId | string | null;
  targetEmail: string;
  token: string;
  status: ProjectTransferStatus;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IProjectTransferDocument extends IProjectTransfer, Document {}

const projectTransferSchema = new Schema<IProjectTransferDocument>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Project",
      index: true,
    },
    currentOwnerId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    targetUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    targetEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: "30d" },
    },
  },
  { timestamps: true },
);

projectTransferSchema.index({ projectId: 1, status: 1 });
projectTransferSchema.index({ targetEmail: 1, status: 1 });

export default model<IProjectTransferDocument>(
  "ProjectTransfer",
  projectTransferSchema,
);
