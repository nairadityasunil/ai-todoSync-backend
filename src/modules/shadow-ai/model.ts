import { Schema, model, type Document, type Types } from "mongoose";

import type { ToolKind } from "./catalog.js";
import type { Source } from "./signals.js";
import type { ToolStatus } from "./risk.js";

export interface ShadowHistoryEntry {
  at: Date;
  by: string | null;
  byName: string;
  action: string;
  detail: string;
}

export interface IShadowTool {
  workspaceId: string;
  toolKey: string;
  name: string;
  vendor: string;
  kind: ToolKind;
  /** In the built-in catalog (true) or guessed from a name (false). */
  catalog: boolean;
  status: ToolStatus;
  decidedBy: string | null;
  decidedByName: string;
  decidedAt: Date | null;
  reason: string;
  conditions: string;
  /** What to use instead (shown to people who run into a restriction). */
  alternative: string;
  vendorId: Types.ObjectId | null;
  useCaseId: Types.ObjectId | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Derived from the sightings after every change. */
  users: number;
  sources: Source[];
  bytesOut: number;
  uploads: number;
  personalShare: number;
  hasSecret: boolean;
  hasBroadGrant: boolean;
  /** Times the extension saw sensitive data (keys, cards, IDs, emails) go into this tool. */
  sensitive: number;
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  history: ShadowHistoryEntry[];
}
export type IShadowToolDocument = IShadowTool & Document;

const HistorySchema = new Schema<ShadowHistoryEntry>(
  { at: Date, by: String, byName: String, action: String, detail: String },
  { _id: false },
);

const ShadowToolSchema = new Schema<IShadowTool>(
  {
    workspaceId: { type: String, required: true },
    toolKey: { type: String, required: true },
    name: { type: String, required: true },
    vendor: { type: String, default: "" },
    kind: { type: String, default: "unknown" },
    catalog: { type: Boolean, default: false },
    status: { type: String, default: "unreviewed" },
    decidedBy: { type: String, default: null },
    decidedByName: { type: String, default: "" },
    decidedAt: { type: Date, default: null },
    reason: { type: String, default: "" },
    conditions: { type: String, default: "" },
    alternative: { type: String, default: "" },
    vendorId: { type: Schema.Types.ObjectId, default: null },
    useCaseId: { type: Schema.Types.ObjectId, default: null },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    users: { type: Number, default: 0 },
    sources: { type: [String], default: [] },
    bytesOut: { type: Number, default: 0 },
    uploads: { type: Number, default: 0 },
    personalShare: { type: Number, default: 0 },
    hasSecret: { type: Boolean, default: false },
    hasBroadGrant: { type: Boolean, default: false },
    sensitive: { type: Number, default: 0 },
    riskScore: { type: Number, default: 0 },
    riskLevel: { type: String, default: "low" },
    history: { type: [HistorySchema], default: [] },
  },
  { timestamps: true },
);
ShadowToolSchema.index({ workspaceId: 1, toolKey: 1 }, { unique: true });
ShadowToolSchema.index({ workspaceId: 1, status: 1, riskScore: -1 });

export const ShadowToolModel = model<IShadowTool>(
  "ShadowTool",
  ShadowToolSchema,
);

/** One person (or machine) using one tool, seen through one source. Aggregated, so a busy proxy log stays small. */
export interface IShadowSighting {
  workspaceId: string;
  toolKey: string;
  /** Lower-case email, or "unknown" when the source has no person (a code scan). */
  userKey: string;
  source: Source;
  count: number;
  bytesOut: number;
  uploads: number;
  personalCount: number;
  firstAt: Date;
  lastAt: Date;
  /** For code: file and line. For OAuth: the scopes. Never a secret. */
  detail: string;
  broad: boolean;
  secret: boolean;
  sensitive: number;
}
export type IShadowSightingDocument = IShadowSighting & Document;

const ShadowSightingSchema = new Schema<IShadowSighting>({
  workspaceId: { type: String, required: true },
  toolKey: { type: String, required: true },
  userKey: { type: String, required: true },
  source: { type: String, required: true },
  count: { type: Number, default: 0 },
  bytesOut: { type: Number, default: 0 },
  uploads: { type: Number, default: 0 },
  personalCount: { type: Number, default: 0 },
  firstAt: { type: Date, default: Date.now },
  lastAt: { type: Date, default: Date.now },
  detail: { type: String, default: "" },
  broad: { type: Boolean, default: false },
  secret: { type: Boolean, default: false },
  sensitive: { type: Number, default: 0 },
});
ShadowSightingSchema.index(
  { workspaceId: 1, toolKey: 1, userKey: 1, source: 1, detail: 1 },
  { unique: true },
);
ShadowSightingSchema.index({ workspaceId: 1, lastAt: -1 });

export const ShadowSightingModel = model<IShadowSighting>(
  "ShadowSighting",
  ShadowSightingSchema,
);

/** A server-side token for log forwarders and scanners. Only a hash is stored. */
export interface IShadowToken {
  workspaceId: string;
  name: string;
  hash: string;
  prefix: string;
  createdBy: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}
export type IShadowTokenDocument = IShadowToken & Document;
const ShadowTokenSchema = new Schema<IShadowToken>(
  {
    workspaceId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    prefix: { type: String, required: true },
    createdBy: { type: String, required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
export const ShadowTokenModel = model<IShadowToken>(
  "ShadowToken",
  ShadowTokenSchema,
);

/** A person declaring or asking for an AI tool (the amnesty and intake flow). */
export interface IShadowRequest {
  workspaceId: string;
  userId: string;
  userName: string;
  toolKey: string;
  toolName: string;
  kind: "declared" | "request";
  purpose: string;
  dataTypes: string[];
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decidedBy: string | null;
  decidedByName: string;
  decidedAt: Date | null;
  decisionNote: string;
  /** Declared during an amnesty window: recorded, no blame. */
  amnesty: boolean;
}
export type IShadowRequestDocument = IShadowRequest & Document;
const ShadowRequestSchema = new Schema<IShadowRequest>(
  {
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    userName: { type: String, default: "" },
    toolKey: { type: String, required: true },
    toolName: { type: String, required: true },
    kind: { type: String, required: true },
    purpose: { type: String, default: "" },
    dataTypes: { type: [String], default: [] },
    status: { type: String, default: "pending" },
    decidedBy: { type: String, default: null },
    decidedByName: { type: String, default: "" },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: "" },
    amnesty: { type: Boolean, default: false },
  },
  { timestamps: true },
);
ShadowRequestSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
export const ShadowRequestModel = model<IShadowRequest>(
  "ShadowRequest",
  ShadowRequestSchema,
);

export interface IShadowSettings {
  workspaceId: string;
  /** Declarations until this date are recorded without consequence. */
  amnestyUntil: Date | null;
  /** Shown to people who open a restricted or prohibited tool's page. */
  coachMessage: string;
  /** Unreviewed tools older than this many days open a review task. */
  reviewDays: number;
}
export type IShadowSettingsDocument = IShadowSettings & Document;
const ShadowSettingsSchema = new Schema<IShadowSettings>(
  {
    workspaceId: { type: String, required: true, unique: true },
    amnestyUntil: { type: Date, default: null },
    coachMessage: { type: String, default: "" },
    reviewDays: { type: Number, default: 14 },
  },
  { timestamps: true },
);
export const ShadowSettingsModel = model<IShadowSettings>(
  "ShadowSettings",
  ShadowSettingsSchema,
);

/** A live link to an identity provider, pulled on a schedule. Credentials are stored encrypted. */
export interface IShadowConnector {
  workspaceId: string;
  type: "google_workspace" | "microsoft_entra";
  name: string;
  /** Encrypted JSON of the credentials. Never returned by the API. */
  credentials: string;
  /** Shown to admins to tell connectors apart: the admin email or tenant. */
  account: string;
  createdBy: string;
  lastSyncAt: Date | null;
  lastStatus: "ok" | "error" | "never";
  lastError: string;
  lastUsers: number;
  lastSignals: number;
  lastTruncated: boolean;
}
export type IShadowConnectorDocument = IShadowConnector & Document;
const ShadowConnectorSchema = new Schema<IShadowConnector>(
  {
    workspaceId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    name: { type: String, required: true },
    credentials: { type: String, required: true },
    account: { type: String, default: "" },
    createdBy: { type: String, required: true },
    lastSyncAt: { type: Date, default: null },
    lastStatus: { type: String, default: "never" },
    lastError: { type: String, default: "" },
    lastUsers: { type: Number, default: 0 },
    lastSignals: { type: Number, default: 0 },
    lastTruncated: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const ShadowConnectorModel = model<IShadowConnector>(
  "ShadowConnector",
  ShadowConnectorSchema,
);
