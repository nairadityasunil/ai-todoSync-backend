import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export type WorkspaceRole = "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" | "GUEST";

export interface IWorkspacePermissions {
  projects?: boolean;
  members?: boolean;
  settings?: boolean;
  agentGovernance?: boolean;
  prompts?: boolean;
  timeTracking?: boolean;
}

export interface IWorkspaceMember {
  workspaceId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  role: WorkspaceRole;
  permissions?: IWorkspacePermissions;
  joinedAt?: Date;
  /** When this person last opened the workspace: the workspace switcher lists the most recent first. */
  lastUsedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IWorkspaceMemberDocument extends IWorkspaceMember, Document {}

const workspaceMemberSchema = new Schema<IWorkspaceMemberDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Workspace",
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    role: {
      type: String,
      enum: ["OWNER", "ADMIN", "MANAGER", "MEMBER", "GUEST"],
      default: "MEMBER",
      required: true,
    },
    permissions: {
      type: new Schema(
        {
          projects: { type: Boolean, default: true },
          members: { type: Boolean, default: false },
          settings: { type: Boolean, default: false },
          agentGovernance: { type: Boolean, default: false },
          prompts: { type: Boolean, default: false },
          timeTracking: { type: Boolean, default: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

const WorkspaceMemberModel = model<IWorkspaceMemberDocument>(
  "WorkspaceMember",
  workspaceMemberSchema,
);

export default WorkspaceMemberModel;
