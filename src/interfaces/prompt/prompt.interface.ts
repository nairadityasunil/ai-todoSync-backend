import type { Types } from "mongoose";

export const PROMPT_CATEGORIES = [
  "general",
  "development",
  "backend",
  "frontend",
  "database",
  "ui-ux",
  "documentation",
  "testing",
  "devops",
  "deployment",
  "ai",
  "security",
  "performance",
  "custom",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export const PROMPT_VISIBILITIES = [
  "private",
  "project",
  "organization",
] as const;
export type PromptVisibility = (typeof PROMPT_VISIBILITIES)[number];

export interface IPromptMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

export interface IPromptVariable {
  name: string;
  type?: "string" | "number" | "json" | "boolean" | "enum";
  description?: string;
  defaultValue?: string;
  required: boolean;
  options?: string[]; // for enum type
  min?: number;
  max?: number;
  regex?: string;
}

export interface IPromptParameters {
  temperature: number;
  maxTokens: number;
  topP: number;
  responseFormat: "text" | "json";
}

export interface IPromptLibrary {
  workspaceId?: Types.ObjectId | string | null;
  projectId?: Types.ObjectId | string | null;
  folderId?: Types.ObjectId | string | null;
  name: string;
  slug?: string;
  description: string;
  category: PromptCategory;
  tags: string[];
  body: string; // fallback string representation
  messages?: IPromptMessage[]; // multi-role block support
  variables: IPromptVariable[];
  provider?: string;
  modelName?: string;
  parameters?: IPromptParameters;
  visibility: PromptVisibility;
  createdBy: Types.ObjectId | string;
  version: number;
  productionVersion?: number;
  isProductionPublished?: boolean;
  publishedAt?: Date;
  hash?: string; // SHA-256 canonical hash
  isLatest: boolean;
  parentId?: Types.ObjectId | string | null; // points to root prompt for versions
  isFavorite: boolean;
  isArchived: boolean;
  isTemplate: boolean; // built-in starter template
  usageCount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPromptFolder {
  workspaceId: Types.ObjectId | string;
  name: string;
  description?: string;
  parentId?: Types.ObjectId | string | null;
  createdBy: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPromptVersion {
  promptId: Types.ObjectId | string;
  version: number;
  environment?: "development" | "staging" | "production" | "canary";
  hash: string;
  body: string;
  messages?: IPromptMessage[];
  variables?: IPromptVariable[];
  provider?: string;
  modelName?: string;
  parameters?: IPromptParameters;
  changedBy: Types.ObjectId | string;
  changeNote?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPromptFavorite {
  workspaceId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  promptId: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreatePromptPayload {
  /** A blank starting point made by a "New prompt" button: the first save replaces it as version 1. */
  draft?: boolean;
  name: string;
  description?: string;
  category?: PromptCategory;
  tags?: string[];
  body: string;
  messages?: IPromptMessage[];
  variables?: IPromptVariable[];
  provider?: string;
  modelName?: string;
  parameters?: IPromptParameters;
  folderId?: string | null;
  projectId?: string | null;
  visibility?: PromptVisibility;
  isTemplate?: boolean;
}

export interface UpdatePromptPayload {
  name?: string;
  description?: string;
  category?: PromptCategory;
  tags?: string[];
  body?: string;
  messages?: IPromptMessage[];
  variables?: IPromptVariable[];
  provider?: string;
  modelName?: string;
  parameters?: IPromptParameters;
  folderId?: string | null;
  projectId?: string | null;
  visibility?: PromptVisibility;
  changeNote?: string;
}
