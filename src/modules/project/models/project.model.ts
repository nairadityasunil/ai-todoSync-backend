import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";
import { encrypt, decrypt } from "../../../utils/encryption.js";

// ─── Custom Fields ──────────────────────────────────────────────────────────

export interface IProjectCustomField {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  options?: string[];
}

// ─── Embedded: AI Config (was ProjectAiConfig) ──────────────────────────────

export type ProjectAiProvider = "gemini" | "openai" | "anthropic";

export interface IProjectAi {
  enabled: boolean;
  provider: ProjectAiProvider;
  apiKey?: string | null;
  baseUrl?: string;
  modelName: string;
  productionPromptId?: Types.ObjectId | string | null;
}

// ─── Embedded: Audit Retention (was AuditRetentionPolicy) ───────────────────

export interface IProjectAudit {
  retentionDays: number;
  legalHold: boolean;
  updatedBy?: Types.ObjectId | string | null;
}

// ─── Embedded: Project States (was ProjectState) ────────────────────────────

export type ProjectStateCategory =
  | "BACKLOG"
  | "UNSTARTED"
  | "STARTED"
  | "COMPLETED"
  | "CANCELED";

export interface IProjectState {
  _id?: any;
  name: string;
  description?: string;
  color: string;
  position: number;
  category: ProjectStateCategory;
  isDefault?: boolean;
  isTerminal?: boolean;
}

// ─── Main Project Interface ──────────────────────────────────────────────────

export interface IProject {
  name: string;
  description?: string;
  userId: Types.ObjectId | string;
  workspaceId?: Types.ObjectId | string | null;
  icon?: string;
  color?: string;
  startDate?: Date | null;
  targetDate?: Date | null;
  status?: "ACTIVE" | "PLANNING" | "PAUSED" | "COMPLETED" | "ARCHIVED";
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  tags?: string[];
  customFields?: IProjectCustomField[];
  isArchived?: boolean;
  /** Data label for agent governance: public, internal (default), confidential, restricted. */
  classification?: string | null;
  /** Embedded AI configuration (formerly ProjectAiConfig collection) */
  ai?: IProjectAi;
  /** Embedded audit retention policy (formerly AuditRetentionPolicy collection) */
  audit?: IProjectAudit;
  /** Embedded workflow states (formerly ProjectState collection) */
  states?: IProjectState[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IProjectDocument extends IProject, Document {}

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const projectAiSchema = new Schema<IProjectAi>(
  {
    enabled: { type: Boolean, default: false },
    provider: {
      type: String,
      enum: ["gemini", "openai", "anthropic"],
      default: "gemini",
    },
    apiKey: {
      type: String,
      default: null,
      get: (v: string) => (v ? decrypt(v) : v),
      set: (v: string) => (v ? encrypt(v) : v),
    },
    baseUrl: { type: String, default: "" },
    modelName: { type: String, default: "Gemini 3.6 Flash" },
    productionPromptId: {
      type: Schema.Types.ObjectId,
      ref: "PromptLibrary",
      default: null,
    },
  },
  { _id: false },
);

const projectAuditSchema = new Schema<IProjectAudit>(
  {
    retentionDays: { type: Number, default: 2555, min: 30, max: 3650 },
    legalHold: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false },
);

const projectStateSchema = new Schema<IProjectState>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    color: { type: String, default: "#6B7280" },
    position: { type: Number, default: 0 },
    category: {
      type: String,
      enum: ["BACKLOG", "UNSTARTED", "STARTED", "COMPLETED", "CANCELED"],
      default: "STARTED",
    },
    isDefault: { type: Boolean, default: false },
    isTerminal: { type: Boolean, default: false },
  },
  { _id: true },
);

// ─── Main Schema ─────────────────────────────────────────────────────────────

const projectSchema = new Schema<IProjectDocument>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },
    icon: { type: String, default: "folder" },
    color: { type: String, default: "#3B82F6" },
    startDate: { type: Date, default: null },
    targetDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ["ACTIVE", "PLANNING", "PAUSED", "COMPLETED", "ARCHIVED"],
      default: "ACTIVE",
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
    },
    tags: { type: [String], default: [] },
    customFields: { type: Array, default: [] },
    isArchived: { type: Boolean, default: false },
    classification: { type: String, enum: ["public", "internal", "confidential", "restricted", null], default: null },
    // Embedded subdocuments (formerly separate collections)
    ai: { type: projectAiSchema, default: () => ({}) },
    audit: { type: projectAuditSchema, default: () => ({}) },
    states: { type: [projectStateSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  },
);

projectSchema.index({ userId: 1, name: 1 }, { unique: true });
projectSchema.index({ workspaceId: 1, name: 1 });

const ProjectModel = model<IProjectDocument>("Project", projectSchema);

export default ProjectModel;
