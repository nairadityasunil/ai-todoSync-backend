import type { Document } from "mongoose";
import { Schema, model } from "mongoose";
import {
  PROMPT_CATEGORIES,
  PROMPT_VISIBILITIES,
  type IPromptLibrary,
  type IPromptMessage,
  type IPromptVariable,
} from "../../../interfaces/prompt/prompt.interface.js";

export { PROMPT_CATEGORIES, PROMPT_VISIBILITIES };
export type {
  PromptCategory,
  PromptVisibility,
} from "../../../interfaces/prompt/prompt.interface.js";

export interface IPromptLibraryDocument extends IPromptLibrary, Document {}

export const promptVariableSchemaDefinition = {
  name: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ["string", "number", "json", "boolean", "enum"],
    default: "string",
  },
  description: { type: String, default: "" },
  defaultValue: { type: String, default: "" },
  required: { type: Boolean, default: false },
  options: [{ type: String, trim: true }],
  min: { type: Number, default: undefined },
  max: { type: Number, default: undefined },
  regex: { type: String, default: undefined },
};

const promptVariableSchema = new Schema<IPromptVariable>(
  promptVariableSchemaDefinition as any,
  { _id: false },
);

const promptMessageSchema = new Schema<IPromptMessage>(
  {
    role: {
      type: String,
      enum: ["system", "developer", "user", "assistant"],
      required: true,
    },
    content: { type: String, required: true },
  },
  { _id: false },
);

const promptLibrarySchema = new Schema<IPromptLibraryDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true,
    },
    folderId: {
      type: Schema.Types.ObjectId,
      ref: "PromptFolder",
      default: null,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, index: true },
    description: { type: String, default: "", maxlength: 500 },
    category: {
      type: String,
      enum: PROMPT_CATEGORIES,
      default: "general",
      required: true,
      index: true,
    },
    tags: [{ type: String, trim: true, lowercase: true }],
    body: { type: String, required: true, maxlength: 20000 },
    messages: [promptMessageSchema],
    variables: [promptVariableSchema],
    provider: { type: String, default: "gemini" },
    modelName: { type: String, default: "gemini-3.6-flash" },
    parameters: {
      temperature: { type: Number, default: 0.7 },
      maxTokens: { type: Number, default: 2048 },
      topP: { type: Number, default: 0.95 },
      responseFormat: { type: String, default: "text" },
    },
    visibility: {
      type: String,
      enum: PROMPT_VISIBILITIES,
      default: "organization",
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    version: { type: Number, default: 0, min: 0 },
    // Nothing is in production until someone deploys a version.
    productionVersion: { type: Number, min: 1 },
    isProductionPublished: { type: Boolean, default: false },
    publishedAt: { type: Date, default: Date.now },
    hash: { type: String, default: "" },
    isLatest: { type: Boolean, default: true, index: true },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: "PromptLibrary",
      default: null,
    },
    isFavorite: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false, index: true },
    isTemplate: { type: Boolean, default: false, index: true },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Indexes
promptLibrarySchema.index({ workspaceId: 1, isLatest: 1, isArchived: 1 });
promptLibrarySchema.index({ workspaceId: 1, parentId: 1, isLatest: 1 });
promptLibrarySchema.index(
  { workspaceId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { isLatest: true } },
);
promptLibrarySchema.index({ projectId: 1, isLatest: 1, isArchived: 1 });
promptLibrarySchema.index({ category: 1, visibility: 1, isLatest: 1 });
promptLibrarySchema.index({ tags: 1 });
promptLibrarySchema.index({
  name: "text",
  description: "text",
  body: "text",
  tags: "text",
});

export default model<IPromptLibraryDocument>(
  "PromptLibrary",
  promptLibrarySchema,
);
