import mongoose, { type Document, Schema, type Types } from "mongoose";

import type { VendorCategory } from "./catalog.js";
import type { VendorRiskFactor, VendorRiskLevel, VendorTier } from "./risk.js";

/**
 * Third-party risk management: one vendor per company a workspace depends
 * on, discovered from agents and webhooks or added by hand, with its
 * status, assessment, contract dates and evidence.
 */

export type VendorStatus =
  | "under_review"
  | "approved"
  | "restricted"
  | "blocked";
export const VENDOR_STATUSES: VendorStatus[] = [
  "under_review",
  "approved",
  "restricted",
  "blocked",
];
export type VendorSource =
  | "ai_provider"
  | "mcp_client"
  | "chatgpt"
  | "detected"
  | "webhook"
  | "manual";

export interface IVendorHistoryEntry {
  at: Date;
  by?: Types.ObjectId | string | null;
  action: string;
  from?: string | null;
  to?: string | null;
  note?: string | null;
}

export interface IVendor {
  workspaceId: Types.ObjectId | string;
  /** Stable id within the workspace, e.g. "openai". */
  key: string;
  name: string;
  category: VendorCategory;
  website?: string | null;
  purpose?: string | null;
  /** Person accountable for the relationship. */
  ownerUserId?: Types.ObjectId | string | null;
  tier: VendorTier;
  status: VendorStatus;
  statusReason?: string | null;
  sources: VendorSource[];
  firstSeenAt: Date;
  lastSeenAt?: Date | null;
  dataLocation?: string | null;
  includeInSubprocessors: boolean;
  dpaExpiresAt?: Date | null;
  contractRenewalAt?: Date | null;
  notes?: string | null;
  answers: Record<string, string>;
  questionnaireVersion?: number | null;
  assessmentCompletedAt?: Date | null;
  assessmentCompletedBy?: Types.ObjectId | string | null;
  nextReviewAt?: Date | null;
  inherentRisk: number;
  residualRisk: number;
  riskLevel: VendorRiskLevel;
  riskFactors: VendorRiskFactor[];
  riskEvaluatedAt?: Date | null;
  history: IVendorHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IVendorDocument extends IVendor, Document {}

const historySchema = new Schema<IVendorHistoryEntry>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    note: { type: String, default: null },
  },
  { _id: false },
);

const riskFactorSchema = new Schema<VendorRiskFactor>(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    weight: { type: Number, required: true },
    framework: { type: String, required: true },
  },
  { _id: false },
);

const vendorSchema = new Schema<IVendorDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    key: { type: String, required: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: {
      type: String,
      enum: [
        "ai_model",
        "ai_assistant",
        "automation",
        "observability",
        "communication",
        "developer_tool",
        "other",
      ],
      default: "other",
    },
    website: { type: String, default: null, maxlength: 300 },
    purpose: { type: String, default: null, maxlength: 300 },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    tier: { type: Number, enum: [1, 2, 3], default: 2 },
    status: { type: String, enum: VENDOR_STATUSES, default: "under_review" },
    statusReason: { type: String, default: null, maxlength: 500 },
    sources: [{ type: String }],
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: null },
    dataLocation: { type: String, default: null, maxlength: 200 },
    includeInSubprocessors: { type: Boolean, default: false },
    dpaExpiresAt: { type: Date, default: null },
    contractRenewalAt: { type: Date, default: null },
    notes: { type: String, default: null, maxlength: 4000 },
    answers: { type: Schema.Types.Mixed, default: {} },
    questionnaireVersion: { type: Number, default: null },
    assessmentCompletedAt: { type: Date, default: null },
    assessmentCompletedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    nextReviewAt: { type: Date, default: null },
    inherentRisk: { type: Number, default: 0 },
    residualRisk: { type: Number, default: 0 },
    riskLevel: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "low",
    },
    riskFactors: { type: [riskFactorSchema], default: [] },
    riskEvaluatedAt: { type: Date, default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

vendorSchema.index({ workspaceId: 1, key: 1 }, { unique: true });
vendorSchema.index({ workspaceId: 1, status: 1 });
vendorSchema.index({ nextReviewAt: 1 });

export const VendorModel = mongoose.model<IVendorDocument>(
  "Vendor",
  vendorSchema,
);

/* ------------------------------ Evidence ------------------------------ */

export type EvidenceKind =
  | "soc2"
  | "iso27001"
  | "iso42001"
  | "dpa"
  | "pentest"
  | "policy"
  | "other";
export const EVIDENCE_KINDS: EvidenceKind[] = [
  "soc2",
  "iso27001",
  "iso42001",
  "dpa",
  "pentest",
  "policy",
  "other",
];

export interface IVendorEvidence {
  workspaceId: Types.ObjectId | string;
  vendorId: Types.ObjectId | string;
  kind: EvidenceKind;
  name: string;
  /** GridFS file id in the "vendorEvidence" bucket. */
  fileId: Types.ObjectId;
  contentType: string;
  size: number;
  sha256: string;
  expiresAt?: Date | null;
  uploadedBy: Types.ObjectId | string;
  createdAt: Date;
}

export interface IVendorEvidenceDocument extends IVendorEvidence, Document {}

const evidenceSchema = new Schema<IVendorEvidenceDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    kind: { type: String, enum: EVIDENCE_KINDS, required: true },
    name: { type: String, required: true, maxlength: 200 },
    fileId: { type: Schema.Types.ObjectId, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

evidenceSchema.index({ vendorId: 1, createdAt: -1 });
evidenceSchema.index({ expiresAt: 1 });

export const VendorEvidenceModel = mongoose.model<IVendorEvidenceDocument>(
  "VendorEvidence",
  evidenceSchema,
);
