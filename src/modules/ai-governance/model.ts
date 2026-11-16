import { Schema, model, type Document, type Types } from "mongoose";

import type {
  AiType,
  ApproverRole,
  EuResult,
  Gate,
  MetricKey,
  Stage,
  Tier,
} from "./catalog.js";
import type { MetricResult, RecordScores, Totals } from "./evaluators.js";

export interface UseCaseRisk {
  id: string;
  code: string | null;
  category: string;
  title: string;
  description: string;
  likelihood: number;
  impact: number;
  treatment: "mitigate" | "accept" | "avoid" | "transfer" | null;
  controls: string[];
  residualLikelihood: number | null;
  residualImpact: number | null;
  status: "open" | "mitigated" | "accepted";
  note: string;
  ownerUserId: string | null;
}

export interface UseCaseApproval {
  gate: Gate;
  role: ApproverRole;
  decision: "approved" | "rejected";
  by: string;
  byName: string;
  at: Date;
  comment: string;
  /** Superseded: the use case was re-assessed or sent back, so this no longer counts. Kept for the audit trail. */
  void?: boolean;
}

export interface HistoryEntry {
  at: Date;
  by: string | null;
  byName: string;
  action: string;
  detail: string;
}

export interface Factsheet {
  intendedUse: string;
  outOfScope: string;
  modelProvider: string;
  modelName: string;
  modelVersion: string;
  dataSources: string;
  humanOversight: string;
  limitations: string;
  fallbackPlan: string;
  disclosure: string;
}

export const FACTSHEET_FIELDS: Array<{
  key: keyof Factsheet;
  label: string;
  required: boolean;
}> = [
  { key: "intendedUse", label: "Intended use", required: true },
  { key: "outOfScope", label: "Out-of-scope uses", required: false },
  { key: "modelProvider", label: "Model provider", required: true },
  { key: "modelName", label: "Model", required: true },
  { key: "modelVersion", label: "Model version", required: false },
  { key: "dataSources", label: "Data sources", required: true },
  { key: "humanOversight", label: "Human oversight", required: true },
  { key: "limitations", label: "Known limitations", required: true },
  { key: "fallbackPlan", label: "Fallback when it fails", required: false },
  { key: "disclosure", label: "How users are told it is AI", required: false },
];

export interface IAiUseCase {
  workspaceId: Types.ObjectId;
  /** Short, stable reference shown to people: UC-12. */
  ref: string;
  name: string;
  description: string;
  businessValue: string;
  type: AiType;
  ownerUserId: Types.ObjectId;
  createdBy: Types.ObjectId;
  stage: Stage;
  /** on_hold: paused by a reviewer; rejected: will not go ahead. */
  status: "active" | "on_hold" | "rejected";
  riskAnswers: Record<string, string>;
  euAnswers: Record<string, string | boolean>;
  assessment: {
    tier: Tier;
    points: number;
    reasons: string[];
    eu: EuResult;
    completedAt: Date;
    by: string;
  } | null;
  factsheet: Factsheet;
  links: {
    agentIds: string[];
    promptIds: string[];
    vendorIds: string[];
    projectId: string | null;
  };
  risks: UseCaseRisk[];
  approvals: UseCaseApproval[];
  thresholds: Partial<Record<MetricKey, number>>;
  evaluation: {
    ranAt: Date;
    status: "pass" | "fail" | "no_data";
    windowDays: number;
    records: number;
    results: MetricResult[];
  } | null;
  /** Keyword profile of the inputs it was validated on, for drift. */
  baseline: { at: Date; records: number; terms: Record<string, number> } | null;
  reviewDays: number | null;
  nextReviewAt: Date | null;
  lastAttestedAt: Date | null;
  lastAttestedBy: string | null;
  score: number;
  history: HistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}
export interface IAiUseCaseDocument extends IAiUseCase, Document {}

const useCaseSchema = new Schema<IAiUseCaseDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    ref: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2000 },
    businessValue: { type: String, default: "", maxlength: 1000 },
    type: {
      type: String,
      enum: ["generative", "predictive", "agentic", "rules"],
      default: "generative",
    },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    stage: {
      type: String,
      enum: [
        "proposed",
        "assessment",
        "development",
        "validation",
        "production",
        "retired",
      ],
      default: "proposed",
    },
    status: {
      type: String,
      enum: ["active", "on_hold", "rejected"],
      default: "active",
    },
    riskAnswers: { type: Schema.Types.Mixed, default: {} },
    euAnswers: { type: Schema.Types.Mixed, default: {} },
    assessment: { type: Schema.Types.Mixed, default: null },
    factsheet: { type: Schema.Types.Mixed, default: {} },
    links: {
      type: Schema.Types.Mixed,
      default: { agentIds: [], promptIds: [], vendorIds: [], projectId: null },
    },
    risks: { type: Schema.Types.Mixed, default: [] } as never,
    approvals: { type: Schema.Types.Mixed, default: [] } as never,
    thresholds: { type: Schema.Types.Mixed, default: {} },
    evaluation: { type: Schema.Types.Mixed, default: null },
    baseline: { type: Schema.Types.Mixed, default: null },
    reviewDays: { type: Number, default: null },
    nextReviewAt: { type: Date, default: null },
    lastAttestedAt: { type: Date, default: null },
    lastAttestedBy: { type: String, default: null },
    score: { type: Number, default: 0 },
    history: { type: Schema.Types.Mixed, default: [] } as never,
  },
  // Two people saving the same use case at once: the second save is refused instead of overwriting the first.
  { timestamps: true, minimize: false, optimisticConcurrency: true },
);
useCaseSchema.index({ workspaceId: 1, stage: 1 });
useCaseSchema.index({ workspaceId: 1, ref: 1 }, { unique: true });

export const AiUseCaseModel = model<IAiUseCaseDocument>(
  "AiUseCase",
  useCaseSchema,
);

/** One logged AI interaction. Text is masked before it is stored; the scores are computed on the original. */
export interface IAiRecord {
  workspaceId: Types.ObjectId;
  useCaseId: Types.ObjectId;
  at: Date;
  input: string;
  output: string;
  hasContext: boolean;
  hasExpected: boolean;
  feedback: "up" | "down" | null;
  latencyMs: number | null;
  scores: RecordScores;
  /** A human-readable list of what was found, for the flagged-records view. */
  flags: string[];
  flagged: boolean;
}
export interface IAiRecordDocument extends IAiRecord, Document {}

/** Six months, the minimum the EU AI Act asks deployers of high-risk systems to keep logs. */
export const RECORD_RETENTION_DAYS = 185;

const recordSchema = new Schema<IAiRecordDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    useCaseId: {
      type: Schema.Types.ObjectId,
      ref: "AiUseCase",
      required: true,
    },
    at: { type: Date, required: true },
    input: { type: String, default: "" },
    output: { type: String, default: "" },
    hasContext: { type: Boolean, default: false },
    hasExpected: { type: Boolean, default: false },
    feedback: { type: String, enum: ["up", "down", null], default: null },
    latencyMs: { type: Number, default: null },
    scores: { type: Schema.Types.Mixed, required: true },
    flags: { type: [String], default: [] },
    flagged: { type: Boolean, default: false },
  },
  { versionKey: false },
);
recordSchema.index({ useCaseId: 1, at: -1 });
recordSchema.index({ useCaseId: 1, flagged: 1, at: -1 });
recordSchema.index(
  { at: 1 },
  { expireAfterSeconds: RECORD_RETENTION_DAYS * 86400 },
);

export const AiRecordModel = model<IAiRecordDocument>("AiRecord", recordSchema);

/**
 * Running totals of one use case's interactions for one hour. Evaluations read
 * these (at most 168 for a week) instead of scanning every record, so they
 * stay fast however many interactions are logged.
 */
export interface IAiMetricBucket extends Totals {
  workspaceId: Types.ObjectId;
  useCaseId: Types.ObjectId;
  hour: Date;
}
export interface IAiMetricBucketDocument extends IAiMetricBucket, Document {}

const num = { type: Number, default: 0 };
const bucketSchema = new Schema<IAiMetricBucketDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    useCaseId: {
      type: Schema.Types.ObjectId,
      ref: "AiUseCase",
      required: true,
    },
    hour: { type: Date, required: true },
    n: num,
    pii: num,
    harmful: num,
    injection: num,
    refusal: num,
    relSum: num,
    relN: num,
    faithSum: num,
    faithN: num,
    corrSum: num,
    corrN: num,
    up: num,
    down: num,
    terms: { type: Schema.Types.Mixed, default: {} },
  },
  { versionKey: false, minimize: false },
);
bucketSchema.index({ useCaseId: 1, hour: 1 }, { unique: true });
bucketSchema.index(
  { hour: 1 },
  { expireAfterSeconds: RECORD_RETENTION_DAYS * 86400 },
);

export const AiMetricBucketModel = model<IAiMetricBucketDocument>(
  "AiMetricBucket",
  bucketSchema,
);

export const ISSUE_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "accepted",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface IAiIssue {
  workspaceId: Types.ObjectId;
  useCaseId: Types.ObjectId;
  title: string;
  description: string;
  severity: Severity;
  status: IssueStatus;
  /** evaluation and review issues are opened and closed by the system. */
  source: "manual" | "evaluation" | "review";
  /** Stable identity for system issues: "evaluation:<useCaseId>:<metric>". */
  key: string | null;
  /** Unique. Equals `key` while a system issue is open, so the same condition cannot open two issues at once. */
  openKey: string;
  metricKey: string | null;
  ownerUserId: Types.ObjectId;
  dueAt: Date | null;
  actions: Array<{
    id: string;
    title: string;
    done: boolean;
    doneAt: Date | null;
    doneBy: string | null;
  }>;
  resolution: string;
  resolvedAt: Date | null;
  createdBy: Types.ObjectId | null;
  history: HistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}
export interface IAiIssueDocument extends IAiIssue, Document {}

const issueSchema = new Schema<IAiIssueDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    useCaseId: {
      type: Schema.Types.ObjectId,
      ref: "AiUseCase",
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", maxlength: 4000 },
    severity: { type: String, enum: SEVERITIES, default: "medium" },
    status: { type: String, enum: ISSUE_STATUSES, default: "open" },
    source: {
      type: String,
      enum: ["manual", "evaluation", "review"],
      default: "manual",
    },
    key: { type: String, default: null },
    openKey: { type: String, required: true },
    metricKey: { type: String, default: null },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    dueAt: { type: Date, default: null },
    actions: { type: Schema.Types.Mixed, default: [] } as never,
    resolution: { type: String, default: "", maxlength: 2000 },
    resolvedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    history: { type: Schema.Types.Mixed, default: [] } as never,
  },
  { timestamps: true },
);
issueSchema.index({ workspaceId: 1, status: 1 });
issueSchema.index({ useCaseId: 1, status: 1 });
issueSchema.index({ key: 1, status: 1 });
issueSchema.index({ openKey: 1 }, { unique: true });

export const AiIssueModel = model<IAiIssueDocument>("AiIssue", issueSchema);

/** Per-workspace settings: who signs for each role, and a counter for use case references. */
export interface IAiGovernanceSettings {
  workspaceId: Types.ObjectId;
  approvers: Partial<Record<ApproverRole, string[]>>;
  /** Extra roles that must sign before a high-risk use case goes to production. */
  highRiskExtraRoles: ApproverRole[];
  nextRef: number;
}
export interface IAiGovernanceSettingsDocument
  extends IAiGovernanceSettings, Document {}

const settingsSchema = new Schema<IAiGovernanceSettingsDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, unique: true },
    approvers: { type: Schema.Types.Mixed, default: {} },
    highRiskExtraRoles: { type: [String], default: [] },
    nextRef: { type: Number, default: 1 },
  },
  { timestamps: true, minimize: false },
);

export const AiGovernanceSettingsModel = model<IAiGovernanceSettingsDocument>(
  "AiGovernanceSettings",
  settingsSchema,
);
