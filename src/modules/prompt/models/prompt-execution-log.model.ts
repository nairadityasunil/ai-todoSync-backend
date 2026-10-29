import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export interface IPromptExecutionLog {
  requestId: string;
  workspaceId: Types.ObjectId | string;
  projectId?: Types.ObjectId | string | null;
  userId: Types.ObjectId | string;
  /** The agent that made the call; null when a person did, in the portal. */
  agentId?: Types.ObjectId | string | null;
  promptId?: Types.ObjectId | string | null;
  promptVersion?: number | null;
  isProduction?: boolean;
  isCanary?: boolean;
  canaryDeploymentId?: Types.ObjectId | string | null;
  source: "playground" | "project_ai" | "mcp" | "ai_planner" | "system";
  provider: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  latencyMs: number;
  status: "success" | "error";
  errorCategory?: string;
  errorMessage?: string;
  createdAt?: Date;
}

export interface IPromptExecutionLogDocument
  extends IPromptExecutionLog, Document {}

const promptExecutionLogSchema = new Schema<IPromptExecutionLogDocument>(
  {
    requestId: { type: String, required: true, index: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
    promptId: {
      type: Schema.Types.ObjectId,
      ref: "PromptLibrary",
      default: null,
      index: true,
    },
    promptVersion: { type: Number, default: null },
    isProduction: { type: Boolean, default: false },
    isCanary: { type: Boolean, default: false },
    canaryDeploymentId: {
      type: Schema.Types.ObjectId,
      ref: "PromptCanaryDeployment",
      default: null,
    },
    source: {
      type: String,
      enum: ["playground", "project_ai", "mcp", "ai_planner", "system"],
      required: true,
      index: true,
    },
    provider: { type: String, required: true },
    modelName: { type: String, required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cachedTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    inputCost: { type: Number, default: 0 },
    outputCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["success", "error"],
      required: true,
      index: true,
    },
    errorCategory: { type: String, default: undefined },
    errorMessage: { type: String, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

promptExecutionLogSchema.index({ workspaceId: 1, createdAt: -1 });
promptExecutionLogSchema.index({ promptId: 1, promptVersion: 1 });

export default model<IPromptExecutionLogDocument>(
  "PromptExecutionLog",
  promptExecutionLogSchema,
);
