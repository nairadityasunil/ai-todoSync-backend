import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";
import type { WorkspaceRole } from "./workspace-member.model.js";

export interface IWorkspaceInvitation {
  workspaceId: Types.ObjectId | string;
  email: string;
  role: WorkspaceRole;
  token: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  invitedBy: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IWorkspaceInvitationDocument
  extends IWorkspaceInvitation, Document {}

const workspaceInvitationSchema = new Schema<IWorkspaceInvitationDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Workspace",
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ["OWNER", "ADMIN", "MANAGER", "MEMBER", "GUEST"],
      required: true,
      default: "MEMBER",
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "REJECTED"],
      required: true,
      default: "PENDING",
    },
    invitedBy: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
  },
  { timestamps: true },
);

workspaceInvitationSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
workspaceInvitationSchema.index({ token: 1 });
workspaceInvitationSchema.index({ email: 1, status: 1 });

const WorkspaceInvitationModel = model<IWorkspaceInvitationDocument>(
  "WorkspaceInvitation",
  workspaceInvitationSchema,
);

export default WorkspaceInvitationModel;
