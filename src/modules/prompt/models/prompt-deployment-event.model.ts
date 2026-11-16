import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export const DEPLOYMENT_ACTIONS = [
  "deployed",
  "canary_started",
  "canary_completed",
  "canary_rolled_back",
  "canary_failed",
  "canary_cancelled",
  "rolled_back",
] as const;
export type DeploymentAction = (typeof DEPLOYMENT_ACTIONS)[number];

/** The actions that change which version is in production. */
export const PRODUCTION_CHANGES: DeploymentAction[] = [
  "deployed",
  "canary_completed",
  "rolled_back",
];

/** One entry in a prompt's deployment history: who put what in production, or took it out, and why. */
export interface IPromptDeploymentEvent {
  workspaceId: Types.ObjectId | string;
  promptId: Types.ObjectId | string;
  action: DeploymentAction;
  /** The version the action is about: the one that went to production, or the canary candidate. */
  version: number;
  /** The production version before this action. */
  previousVersion: number | null;
  reason: string;
  by: Types.ObjectId | string | null;
  createdAt?: Date;
}
export interface IPromptDeploymentEventDocument
  extends IPromptDeploymentEvent, Document {}

const schema = new Schema<IPromptDeploymentEventDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    promptId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, enum: DEPLOYMENT_ACTIONS, required: true },
    version: { type: Number, required: true },
    previousVersion: { type: Number, default: null },
    reason: { type: String, default: "", maxlength: 500 },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
schema.index({ promptId: 1, createdAt: -1 });

export default model<IPromptDeploymentEventDocument>(
  "PromptDeploymentEvent",
  schema,
);
