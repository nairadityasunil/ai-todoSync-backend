import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export interface IWorkspaceSettings {
  defaultProjectRole?: string;
  allowGuestInvites?: boolean;
  /** Mask personal data and secrets before prompts go to AI providers. */
  aiDataMasking?: boolean;
  /** Scripts and automated browsers must use an agent key, not a person's login. */
  requireAgentKeys?: boolean;
  /** Suspend agents unused for this many days (0: never). */
  inactiveAgentDays?: number;
  /** Monthly AI budget in USD (UTC month); 0 means no limit. */
  aiMonthlyBudgetUsd?: number;
  /** Refuse AI calls once the budget is used up (otherwise only alert). */
  aiBudgetHardStop?: boolean;
}

export interface IWorkspace {
  name: string;
  slug: string;
  ownerId: Types.ObjectId | string;
  settings?: IWorkspaceSettings;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IWorkspaceDocument extends IWorkspace, Document {}

const workspaceSchema = new Schema<IWorkspaceDocument>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    settings: {
      defaultProjectRole: { type: String, default: "MEMBER" },
      allowGuestInvites: { type: Boolean, default: true },
      aiDataMasking: { type: Boolean, default: false },
      requireAgentKeys: { type: Boolean, default: false },
      inactiveAgentDays: { type: Number, default: 60 },
      aiMonthlyBudgetUsd: { type: Number, default: 100 },
      aiBudgetHardStop: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

workspaceSchema.index({ ownerId: 1 });
workspaceSchema.index({ slug: 1 }, { unique: true });

const WorkspaceModel = model<IWorkspaceDocument>("Workspace", workspaceSchema);

export default WorkspaceModel;
