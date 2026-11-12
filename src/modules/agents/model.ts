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
  /** The third party behind it (see vendors module); null for the workspace's own. */
  vendorId?: Types.ObjectId | string | null;
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
  /** Suspended automatically (critical risk, threat or incident); any admin or the owner can resume. */
  suspendedBySystem?: boolean;
  /** After an incident: the agent's next change needs a person's approval. */
  reapprovalRequired?: boolean;
  /** When the current key was issued (creation or last rotation). */
  keyIssuedAt?: Date | null;
  /** "vendor": the key is used by a third party (stricter rules). */
  operatedBy?: "internal" | "vendor";
  /** The key before the last rotation, still accepted until previousKeyExpiresAt. */
  previousKeyHash?: string | null;
  previousKeyExpiresAt?: Date | null;
  /** The owner was told the current key is due for rotation. */
  rotationNotifiedAt?: Date | null;
  /** A key the system rotated, encrypted, until the owner reveals it once. */
  pendingKeyCiphertext?: string | null;
  pendingKeyIssuedAt?: Date | null;
  /** Network addresses (and countries) this agent normally uses. */
  knownIps?: Array<{ ip: string; country?: string | null; firstSeen: Date; lastSeen: Date }>;
  expiresAt?: Date | null;
  /** Calls allowed per minute across REST, MCP and AI; null for no limit. */
  rateLimitPerMinute?: number | null;
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
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", default: null },
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
    suspendedBySystem: { type: Boolean, default: false },
    reapprovalRequired: { type: Boolean, default: false },
    keyIssuedAt: { type: Date, default: null },
    operatedBy: { type: String, enum: ["internal", "vendor"], default: "internal" },
    previousKeyHash: { type: String, default: null },
    previousKeyExpiresAt: { type: Date, default: null },
    rotationNotifiedAt: { type: Date, default: null },
    pendingKeyCiphertext: { type: String, default: null },
    pendingKeyIssuedAt: { type: Date, default: null },
    knownIps: {
      type: [
        new Schema(
          { ip: String, country: { type: String, default: null }, firstSeen: Date, lastSeen: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    expiresAt: { type: Date, default: null },
    rateLimitPerMinute: { type: Number, default: null },
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
agentSchema.index(
  { previousKeyHash: 1 },
  { partialFilterExpression: { previousKeyHash: { $type: "string" } } },
);
agentSchema.index({ workspaceId: 1, status: 1 });
agentSchema.index({ sessionId: 1 }, { sparse: true });
agentSchema.index({ deviceId: 1 }, { sparse: true });
agentSchema.index({ vendorId: 1 }, { sparse: true });

export const AgentModel = mongoose.model<IAgentDocument>("Agent", agentSchema);

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export type PolicyEffect = "allow" | "deny" | "require_approval";
/** "simulation": a draft that is never evaluated live, only replayed. */
export type PolicyMode = "enforce" | "advisory" | "simulation";

export interface IPolicyMatch {
  agentKinds?: AgentKind[];
  agentIds?: string[];
  /** Tool names; "*" suffix matches a prefix, e.g. "delete_*". */
  tools?: string[];
  domains?: string[];
  minRisk?: RiskLevel | null;
  projectIds?: string[];
  /** Only for data with these labels (task label, else project label). */
  classifications?: string[];
  /** Only for agents operated by the workspace or by a third party. */
  operatedBy?: Array<"internal" | "vendor">;
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
    mode: { type: String, enum: ["enforce", "advisory", "simulation"], default: "advisory" },
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
  /** "policy": an explicit policy decided; "system": a default rule, DLP, threat or safety net; "person": a person's approval. */
  decidedBy?: "policy" | "system" | "person" | null;
  /** The rule behind a system decision, e.g. "Default rule: low risk, allowed automatically". */
  rule?: string | null;
  tier?: string | null;
  dlp?: Array<{ type: string; label: string; confidence: string; count: number }>;
  threats?: string[];
  ip?: string | null;
  /** Label of the data touched. */
  classification?: string | null;
  /** Why the call was riskier than usual (baseline, session). */
  signals?: string[];
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
    decidedBy: { type: String, default: null },
    rule: { type: String, default: null },
    tier: { type: String, default: null },
    dlp: { type: [Schema.Types.Mixed], default: [] },
    threats: { type: [String], default: [] },
    ip: { type: String, default: null },
    classification: { type: String, default: null },
    signals: { type: [String], default: [] },
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
  tier?: string | null;
  recommendation?: { decision: "approve" | "reject"; reasons: string[] } | null;
  dlp?: Array<{ type: string; label: string; confidence: string; count: number }>;
  decidedBySystem?: boolean;
  classification?: string | null;
  signals?: string[];
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
    tier: { type: String, default: null },
    recommendation: { type: Schema.Types.Mixed, default: null },
    dlp: { type: [Schema.Types.Mixed], default: [] },
    /** Decided by the system (auto-approve of a repeat), not a person. */
    decidedBySystem: { type: Boolean, default: false },
    classification: { type: String, default: null },
    signals: { type: [String], default: [] },
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
  | "threat"
  | "dlp"
  | "compliance_drift"
  | "critical_risk"
  | "bulk_destructive"
  | "volume_spike"
  | "off_hours"
  | "new_tool"
  | "permission_errors"
  | "policy_block"
  | "stale_agent"
  | "anomaly"
  | "coordinated_access"
  | "key_rotation_due"
  | "session_risk";

export interface IAgentAlert {
  workspaceId?: Types.ObjectId | string | null;
  /** The agent it concerns; null for vendor-level alerts. */
  agentId?: Types.ObjectId | string | null;
  /** The third party it concerns, for vendor alerts. */
  vendorId?: Types.ObjectId | string | null;
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
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", default: null },
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

/* ------------------------------------------------------------------ */
/* Webhooks: governance events to Slack, SIEM tools and other systems  */
/* ------------------------------------------------------------------ */

export type WebhookFormat = "json" | "slack";
export type WebhookEvent =
  | "alert.raised"
  | "approval.requested"
  | "approval.decided"
  | "activity.blocked"
  | "incident.opened"
  | "compliance.report"
  | "compliance.drift"
  | "playbook.run"
  | "access.requested";

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  "alert.raised",
  "approval.requested",
  "approval.decided",
  "activity.blocked",
  "incident.opened",
  "compliance.report",
  "compliance.drift",
  "playbook.run",
  "access.requested",
];

export interface IAgentWebhook {
  workspaceId: Types.ObjectId | string;
  name: string;
  url: string;
  format: WebhookFormat;
  events: WebhookEvent[];
  /** Alerts below this severity are not sent. */
  minSeverity: "info" | "warning" | "critical";
  /** Signing secret, encrypted at rest. */
  secret: string;
  /** The service it delivers to, when it is a known third party. */
  vendorId?: Types.ObjectId | string | null;
  enabled: boolean;
  /** Turned off after repeated failures; the reason is kept. */
  disabledReason?: string | null;
  consecutiveFailures: number;
  lastDeliveryAt?: Date | null;
  lastStatus?: number | null;
  lastError?: string | null;
  createdBy: Types.ObjectId | string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentWebhookDocument extends IAgentWebhook, Document {}

const agentWebhookSchema = new Schema<IAgentWebhookDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, maxlength: 2000 },
    format: { type: String, enum: ["json", "slack"], default: "json" },
    events: [{ type: String, enum: WEBHOOK_EVENTS }],
    minSeverity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "warning",
    },
    secret: { type: String, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", default: null },
    enabled: { type: Boolean, default: true },
    disabledReason: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    lastDeliveryAt: { type: Date, default: null },
    lastStatus: { type: Number, default: null },
    lastError: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

agentWebhookSchema.index({ workspaceId: 1, enabled: 1 });

export const AgentWebhookModel = mongoose.model<IAgentWebhookDocument>(
  "AgentWebhook",
  agentWebhookSchema,
);

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

export type IncidentStatus = "open" | "contained" | "resolved";

export interface IIncidentEntry {
  at: Date;
  /** "system" for automatic actions, otherwise the person who acted. */
  actor: "system" | "person";
  userId?: Types.ObjectId | string | null;
  action: string;
  detail: string;
}

export interface IAgentIncident {
  workspaceId?: Types.ObjectId | string | null;
  title: string;
  severity: "warning" | "critical";
  /** What opened it: a threat type, "critical_risk", "dlp" or "manual". */
  trigger: string;
  status: IncidentStatus;
  agentIds: Array<Types.ObjectId | string>;
  /** The action that triggered it, when there was one. */
  action?: string | null;
  summary: string;
  timeline: IIncidentEntry[];
  suggestions: string[];
  /** Activity window kept with the incident (from, to). */
  windowFrom: Date;
  windowTo?: Date | null;
  resolution?: string | null;
  resolvedAt?: Date | null;
  resolvedBy?: Types.ObjectId | string | null;
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentIncidentDocument extends IAgentIncident, Document {}

const incidentEntrySchema = new Schema<IIncidentEntry>(
  {
    at: { type: Date, default: Date.now },
    actor: { type: String, enum: ["system", "person"], required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true },
    detail: { type: String, default: "" },
  },
  { _id: false },
);

const agentIncidentSchema = new Schema<IAgentIncidentDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null, index: true },
    title: { type: String, required: true },
    severity: { type: String, enum: ["warning", "critical"], required: true },
    trigger: { type: String, required: true },
    status: { type: String, enum: ["open", "contained", "resolved"], default: "open" },
    agentIds: [{ type: Schema.Types.ObjectId, ref: "Agent" }],
    action: { type: String, default: null },
    summary: { type: String, default: "" },
    timeline: { type: [incidentEntrySchema], default: [] },
    suggestions: { type: [String], default: [] },
    windowFrom: { type: Date, required: true },
    windowTo: { type: Date, default: null },
    resolution: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dedupeKey: { type: String, required: true },
  },
  { timestamps: true },
);
agentIncidentSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
agentIncidentSchema.index({ dedupeKey: 1 });

export const AgentIncidentModel = mongoose.model<IAgentIncidentDocument>(
  "AgentIncident",
  agentIncidentSchema,
);

/* ------------------------------------------------------------------ */
/* Governance events: what the system (or a person) did to governance */
/* itself, e.g. auto-suspend, compliance reports, drift               */
/* ------------------------------------------------------------------ */

export interface IGovernanceEvent {
  workspaceId?: Types.ObjectId | string | null;
  type: string;
  actor: "system" | "person";
  userId?: Types.ObjectId | string | null;
  agentId?: Types.ObjectId | string | null;
  incidentId?: Types.ObjectId | string | null;
  title: string;
  detail: string;
  createdAt: Date;
}

export interface IGovernanceEventDocument extends IGovernanceEvent, Document {}

const governanceEventSchema = new Schema<IGovernanceEventDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    type: { type: String, required: true },
    actor: { type: String, enum: ["system", "person"], required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
    incidentId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
governanceEventSchema.index({ workspaceId: 1, createdAt: -1 });
governanceEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 86400 },
);

export const GovernanceEventModel = mongoose.model<IGovernanceEventDocument>(
  "GovernanceEvent",
  governanceEventSchema,
);

/* ------------------------------------------------------------------ */
/* Compliance snapshots (score history and drift)                      */
/* ------------------------------------------------------------------ */

export interface IComplianceSnapshot {
  workspaceId: Types.ObjectId | string;
  score: number;
  controls: Array<{ id: string; title: string; status: string }>;
  createdAt: Date;
}

export interface IComplianceSnapshotDocument extends IComplianceSnapshot, Document {}

const complianceSnapshotSchema = new Schema<IComplianceSnapshotDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    score: { type: Number, required: true },
    controls: { type: Schema.Types.Mixed, default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
complianceSnapshotSchema.index({ workspaceId: 1, createdAt: -1 });
complianceSnapshotSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 400 * 86400 },
);

export const ComplianceSnapshotModel = mongoose.model<IComplianceSnapshotDocument>(
  "ComplianceSnapshot",
  complianceSnapshotSchema,
);
