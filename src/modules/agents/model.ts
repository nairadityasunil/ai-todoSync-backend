import mongoose, { type Document, Schema, type Types } from "mongoose";

import type { McpScope, RiskLevel } from "../mcp/registry/tool-types.js";

/**
 * Agent governance data model.
 *
 * An "agent" is anything that acts on a user's behalf without the user
 * clicking through the portal: API keys (including the legacy Sync key),
 * MCP clients, ChatGPT Actions, companion devices and project AI providers.
 */

export type AgentKind =
  | "api_key"
  | "mcp_client"
  | "chatgpt"
  | "companion"
  | "ai_provider"
  /** A script or automated browser found using a person's own login. */
  | "detected";
export type AgentStatus = "active" | "suspended" | "revoked";
export type AgentRiskLevel = "low" | "medium" | "high" | "critical";

export interface IAgentRiskFactor {
  code: string;
  label: string;
  weight: number;
  frameworks: string[];
}

export interface IAgent {
  workspaceId?: Types.ObjectId | string | null;
  ownerUserId: Types.ObjectId | string;
  kind: AgentKind;
  name: string;
  /** Stable identity for self-registering agents (e.g. MCP client per user). */
  fingerprint?: string | null;
  clientName?: string | null;
  userAgent?: string | null;
  /** Why a "detected" agent was judged automated (see detection.ts). */
  detectionSignals: string[];
  /** The agent key that replaced this detected agent. */
  replacedByAgentId?: Types.ObjectId | string | null;
  /** sha256 of the API key; only for kind api_key. */
  keyHash?: string | null;
  keyPrefix?: string | null;
  sessionId?: Types.ObjectId | string | null;
  deviceId?: Types.ObjectId | string | null;
  scopes: McpScope[];
  /** Projects the agent may touch; empty means every project the owner can. */
  projectIds: Array<Types.ObjectId | string>;
  status: AgentStatus;
  legacy: boolean;
  statusReason?: string | null;
  /** Suspended or revoked by a workspace admin: only an admin may lift it. */
  statusSetByAdmin: boolean;
  /** Permissions were narrowed by an admin: the owner may only narrow further. */
  adminLocked: boolean;
  expiresAt?: Date | null;
  lastSeenAt?: Date | null;
  /** Last time its owner (or an admin) confirmed it is still needed. */
  reviewedAt?: Date | null;
  reviewedBy?: Types.ObjectId | string | null;
  callCount: number;
  riskScore: number;
  riskLevel: AgentRiskLevel;
  riskFactors: IAgentRiskFactor[];
  riskEvaluatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentDocument extends IAgent, Document {}

const riskFactorSchema = new Schema<IAgentRiskFactor>(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    weight: { type: Number, required: true },
    frameworks: [{ type: String }],
  },
  { _id: false },
);

const agentSchema = new Schema<IAgentDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
    },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: {
      type: String,
      enum: [
        "api_key",
        "mcp_client",
        "chatgpt",
        "companion",
        "ai_provider",
        "detected",
      ],
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    fingerprint: { type: String, default: null },
    clientName: { type: String, default: null },
    userAgent: { type: String, default: null },
    detectionSignals: { type: [String], default: [] },
    replacedByAgentId: { type: Schema.Types.ObjectId, default: null },
    keyHash: { type: String, default: null },
    keyPrefix: { type: String, default: null },
    sessionId: { type: Schema.Types.ObjectId, default: null },
    deviceId: { type: Schema.Types.ObjectId, default: null },
    scopes: [{ type: String }],
    projectIds: [{ type: Schema.Types.ObjectId, ref: "Project" }],
    status: {
      type: String,
      enum: ["active", "suspended", "revoked"],
      default: "active",
    },
    legacy: { type: Boolean, default: false },
    statusReason: { type: String, default: null },
    statusSetByAdmin: { type: Boolean, default: false },
    adminLocked: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    callCount: { type: Number, default: 0 },
    riskScore: { type: Number, default: 0 },
    riskLevel: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "low",
    },
    riskFactors: { type: [riskFactorSchema], default: [] },
    riskEvaluatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Partial, not sparse: agents without a key store keyHash/fingerprint as
// null, and a sparse unique index still counts nulls as duplicates.
agentSchema.index(
  { keyHash: 1 },
  { unique: true, partialFilterExpression: { keyHash: { $type: "string" } } },
);
// One self-registered agent per user, kind and client (prevents duplicates
// when a new client's first calls arrive in parallel).
agentSchema.index(
  { ownerUserId: 1, kind: 1, fingerprint: 1, workspaceId: 1 },
  {
    unique: true,
    partialFilterExpression: { fingerprint: { $type: "string" } },
  },
);
// One agent per AI provider per workspace.
agentSchema.index(
  { workspaceId: 1, fingerprint: 1 },
  { unique: true, partialFilterExpression: { kind: "ai_provider" } },
);
agentSchema.index({ workspaceId: 1, status: 1 });
agentSchema.index({ sessionId: 1 }, { sparse: true });
agentSchema.index({ deviceId: 1 }, { sparse: true });

export const AgentModel = mongoose.model<IAgentDocument>("Agent", agentSchema);

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export type PolicyEffect = "allow" | "deny" | "require_approval";
export type PolicyMode = "enforce" | "advisory";

export interface IPolicyMatch {
  agentKinds?: AgentKind[];
  agentIds?: string[];
  /** Tool names; "*" suffix matches a prefix, e.g. "delete_*". */
  tools?: string[];
  domains?: string[];
  minRisk?: RiskLevel | null;
  projectIds?: string[];
  /** Only between these hours (0-23, workspace timezone) on these weekdays (0=Sun). */
  timeWindow?: {
    days?: number[];
    startHour?: number;
    endHour?: number;
    timezone?: string;
    /** true = match OUTSIDE the window (e.g. "outside business hours"). */
    outside?: boolean;
  } | null;
}

export interface IAgentPolicy {
  workspaceId: Types.ObjectId | string;
  name: string;
  description?: string;
  effect: PolicyEffect;
  mode: PolicyMode;
  priority: number;
  enabled: boolean;
  match: IPolicyMatch;
  createdBy: Types.ObjectId | string;
  updatedBy?: Types.ObjectId | string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentPolicyDocument extends IAgentPolicy, Document {}

const agentPolicySchema = new Schema<IAgentPolicyDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 500 },
    effect: {
      type: String,
      enum: ["allow", "deny", "require_approval"],
      required: true,
    },
    mode: { type: String, enum: ["enforce", "advisory"], default: "advisory" },
    priority: { type: Number, default: 100 },
    enabled: { type: Boolean, default: true },
    match: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

agentPolicySchema.index({ workspaceId: 1, enabled: 1, priority: -1 });

export const AgentPolicyModel = mongoose.model<IAgentPolicyDocument>(
  "AgentPolicy",
  agentPolicySchema,
);

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

export type AgentActivityOutcome =
  | "allowed"
  | "blocked"
  | "pending_approval"
  | "error";

export interface IAgentActivity {
  agentId: Types.ObjectId | string;
  workspaceId?: Types.ObjectId | string | null;
  projectId?: Types.ObjectId | string | null;
  userId: Types.ObjectId | string;
  channel: "mcp" | "rest";
  action: string;
  domain: string;
  risk: RiskLevel;
  input: Record<string, unknown>;
  outcome: AgentActivityOutcome;
  statusCode?: number | null;
  policyId?: Types.ObjectId | string | null;
  policyName?: string | null;
  advisoryPolicies: string[];
  approvalId?: Types.ObjectId | string | null;
  error?: string | null;
  durationMs?: number | null;
  /** State of the changed record before the agent touched it. */
  undo?: AgentUndoSnapshot | null;
  undoneAt?: Date | null;
  undoneBy?: Types.ObjectId | string | null;
  createdAt: Date;
}

export interface AgentUndoSnapshot {
  entityType: "task" | "epic";
  entityId: string;
  /** Full document, or null when the agent created the record. */
  before: Record<string, unknown> | null;
}

export interface IAgentActivityDocument extends IAgentActivity, Document {}

export const AGENT_ACTIVITY_RETENTION_DAYS = 90;

const agentActivitySchema = new Schema<IAgentActivityDocument>(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    projectId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: ["mcp", "rest"], required: true },
    action: { type: String, required: true },
    domain: { type: String, required: true },
    risk: { type: String, required: true },
    input: { type: Schema.Types.Mixed, default: {} },
    outcome: {
      type: String,
      enum: ["allowed", "blocked", "pending_approval", "error"],
      required: true,
    },
    statusCode: { type: Number, default: null },
    policyId: { type: Schema.Types.ObjectId, default: null },
    policyName: { type: String, default: null },
    advisoryPolicies: [{ type: String }],
    approvalId: { type: Schema.Types.ObjectId, default: null },
    error: { type: String, default: null },
    durationMs: { type: Number, default: null },
    undo: { type: Schema.Types.Mixed, default: null },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: Schema.Types.ObjectId, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, minimize: false },
);

agentActivitySchema.index({ agentId: 1, createdAt: -1 });
agentActivitySchema.index({ workspaceId: 1, createdAt: -1 });
agentActivitySchema.index({ workspaceId: 1, outcome: 1, createdAt: -1 });
agentActivitySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: AGENT_ACTIVITY_RETENTION_DAYS * 86400 },
);

export const AgentActivityModel = mongoose.model<IAgentActivityDocument>(
  "AgentActivity",
  agentActivitySchema,
);

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export type AgentApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "failed";

export interface IAgentApproval {
  workspaceId?: Types.ObjectId | string | null;
  projectId?: Types.ObjectId | string | null;
  agentId: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  channel: "mcp" | "rest";
  action: string;
  domain: string;
  risk: RiskLevel;
  /** Exactly what the agent sent, replayed once on approval. */
  input: Record<string, unknown>;
  /** Masked copy shown to approvers. */
  inputPreview: Record<string, unknown>;
  request?: { method: string; path: string } | null;
  policyId?: Types.ObjectId | string | null;
  policyName?: string | null;
  status: AgentApprovalStatus;
  decidedBy?: Types.ObjectId | string | null;
  decidedAt?: Date | null;
  note?: string | null;
  result?: unknown;
  error?: string | null;
  /** sha256 of the one-time token used to replay an approved REST call. */
  replayTokenHash?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentApprovalDocument extends IAgentApproval, Document {}

const agentApprovalSchema = new Schema<IAgentApprovalDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    projectId: { type: Schema.Types.ObjectId, default: null },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: ["mcp", "rest"], required: true },
    action: { type: String, required: true },
    domain: { type: String, required: true },
    risk: { type: String, required: true },
    input: { type: Schema.Types.Mixed, default: {} },
    inputPreview: { type: Schema.Types.Mixed, default: {} },
    request: { type: Schema.Types.Mixed, default: null },
    policyId: { type: Schema.Types.ObjectId, default: null },
    policyName: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "pending",
        "approved",
        "rejected",
        "expired",
        "executed",
        "failed",
      ],
      default: "pending",
    },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    replayTokenHash: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

agentApprovalSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
agentApprovalSchema.index({ agentId: 1, createdAt: -1 });
agentApprovalSchema.index({ replayTokenHash: 1 }, { sparse: true });

export const AgentApprovalModel = mongoose.model<IAgentApprovalDocument>(
  "AgentApproval",
  agentApprovalSchema,
);

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

export type AgentAlertSeverity = "info" | "warning" | "critical";
export type AgentAlertType =
  | "bulk_destructive"
  | "volume_spike"
  | "off_hours"
  | "new_tool"
  | "permission_errors"
  | "policy_block"
  | "stale_agent";

export interface IAgentAlert {
  workspaceId?: Types.ObjectId | string | null;
  agentId: Types.ObjectId | string;
  type: AgentAlertType;
  severity: AgentAlertSeverity;
  title: string;
  detail: string;
  /** Prevents raising the same alert twice in a window. */
  dedupeKey: string;
  acknowledgedBy?: Types.ObjectId | string | null;
  acknowledgedAt?: Date | null;
  createdAt: Date;
}

export interface IAgentAlertDocument extends IAgentAlert, Document {}

const agentAlertSchema = new Schema<IAgentAlertDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    type: { type: String, required: true },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      required: true,
    },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    dedupeKey: { type: String, required: true },
    acknowledgedBy: { type: Schema.Types.ObjectId, default: null },
    acknowledgedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

agentAlertSchema.index({ dedupeKey: 1 }, { unique: true });
agentAlertSchema.index({ workspaceId: 1, acknowledgedAt: 1, createdAt: -1 });
agentAlertSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: AGENT_ACTIVITY_RETENTION_DAYS * 86400 },
);

export const AgentAlertModel = mongoose.model<IAgentAlertDocument>(
  "AgentAlert",
  agentAlertSchema,
);

/* ------------------------------------------------------------------ */
/* MCP confirmation tokens (persisted so they survive restarts and     */
/* work across several server instances)                               */
/* ------------------------------------------------------------------ */

export interface IMcpConfirmation {
  tokenHash: string;
  toolName: string;
  userId: string;
  expiresAt: Date;
}

export interface IMcpConfirmationDocument extends IMcpConfirmation, Document {}

const mcpConfirmationSchema = new Schema<IMcpConfirmationDocument>(
  {
    tokenHash: { type: String, required: true, unique: true },
    toolName: { type: String, required: true },
    userId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

mcpConfirmationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpConfirmationModel = mongoose.model<IMcpConfirmationDocument>(
  "McpConfirmation",
  mcpConfirmationSchema,
);
