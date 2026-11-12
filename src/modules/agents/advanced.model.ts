import mongoose, { type Document, Schema, type Types } from "mongoose";

/* ------------------------------------------------------------------ */
/* Behaviour baselines: what "normal" looks like for each agent         */
/* ------------------------------------------------------------------ */

export interface IAgentBaseline {
  agentId: Types.ObjectId | string;
  workspaceId?: Types.ObjectId | string | null;
  days: number;
  sample: number;
  hourlyP50: number;
  hourlyP95: number;
  dailyP50: number;
  dailyP95: number;
  actions: string[];
  projects: string[];
  errorRate: number;
  ready: boolean;
  computedAt: Date;
}

export interface IAgentBaselineDocument extends IAgentBaseline, Document {}

const baselineSchema = new Schema<IAgentBaselineDocument>(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true, unique: true },
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    days: { type: Number, default: 0 },
    sample: { type: Number, default: 0 },
    hourlyP50: { type: Number, default: 0 },
    hourlyP95: { type: Number, default: 0 },
    dailyP50: { type: Number, default: 0 },
    dailyP95: { type: Number, default: 0 },
    actions: { type: [String], default: [] },
    projects: { type: [String], default: [] },
    errorRate: { type: Number, default: 0 },
    ready: { type: Boolean, default: false },
    computedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

export const AgentBaselineModel = mongoose.model<IAgentBaselineDocument>("AgentBaseline", baselineSchema);

/* ------------------------------------------------------------------ */
/* Just-in-time access                                                 */
/* ------------------------------------------------------------------ */

export type ElevationStatus = "pending" | "active" | "rejected" | "expired" | "revoked";

export interface IAgentElevation {
  workspaceId?: Types.ObjectId | string | null;
  agentId: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  scopes: string[];
  reason: string;
  durationMinutes: number;
  status: ElevationStatus;
  tier: string;
  decidedBy?: Types.ObjectId | string | null;
  decidedBySystem: boolean;
  decidedAt?: Date | null;
  note?: string | null;
  grantedAt?: Date | null;
  /** When the grant ends (active) or the request lapses (pending). */
  expiresAt: Date;
  endedAt?: Date | null;
  usedCount: number;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentElevationDocument extends IAgentElevation, Document {}

const elevationSchema = new Schema<IAgentElevationDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scopes: { type: [String], required: true },
    reason: { type: String, default: "", maxlength: 500 },
    durationMinutes: { type: Number, required: true },
    status: { type: String, enum: ["pending", "active", "rejected", "expired", "revoked"], default: "pending" },
    tier: { type: String, default: "medium" },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedBySystem: { type: Boolean, default: false },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: null },
    grantedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    usedCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
elevationSchema.index({ agentId: 1, status: 1, expiresAt: 1 });
elevationSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

export const AgentElevationModel = mongoose.model<IAgentElevationDocument>("AgentElevation", elevationSchema);

/* ------------------------------------------------------------------ */
/* Playbooks: automated response to threats, DLP and compliance events  */
/* ------------------------------------------------------------------ */

export interface IAgentPlaybook {
  workspaceId: Types.ObjectId | string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { types: string[]; minSeverity: "info" | "warning" | "critical" };
  steps: Array<{ type: string }>;
  createdBy: Types.ObjectId | string;
  lastRunAt?: Date | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentPlaybookDocument extends IAgentPlaybook, Document {}

const playbookSchema = new Schema<IAgentPlaybookDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 500 },
    enabled: { type: Boolean, default: true },
    trigger: {
      types: { type: [String], default: [] },
      minSeverity: { type: String, enum: ["info", "warning", "critical"], default: "critical" },
    },
    steps: { type: [new Schema({ type: { type: String, required: true } }, { _id: false })], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastRunAt: { type: Date, default: null },
    runCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
playbookSchema.index({ workspaceId: 1, enabled: 1 });

export const AgentPlaybookModel = mongoose.model<IAgentPlaybookDocument>("AgentPlaybook", playbookSchema);

export type PlaybookRunStatus = "running" | "waiting" | "completed" | "cancelled" | "failed";

export interface IPlaybookRunStep {
  type: string;
  status: "pending" | "done" | "skipped" | "failed" | "waiting";
  actor?: "system" | "person" | null;
  detail?: string;
  at?: Date | null;
}

export interface IPlaybookRun {
  workspaceId?: Types.ObjectId | string | null;
  playbookId: Types.ObjectId | string;
  playbookName: string;
  agentId?: Types.ObjectId | string | null;
  trigger: { type: string; severity: string; title: string; detail: string };
  status: PlaybookRunStatus;
  steps: IPlaybookRunStep[];
  incidentId?: Types.ObjectId | string | null;
  decidedBy?: Types.ObjectId | string | null;
  decidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPlaybookRunDocument extends IPlaybookRun, Document {}

const runSchema = new Schema<IPlaybookRunDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    playbookId: { type: Schema.Types.ObjectId, ref: "AgentPlaybook", required: true },
    playbookName: { type: String, required: true },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", default: null },
    trigger: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["running", "waiting", "completed", "cancelled", "failed"], default: "running" },
    steps: {
      type: [
        new Schema(
          {
            type: { type: String, required: true },
            status: { type: String, default: "pending" },
            actor: { type: String, default: null },
            detail: { type: String, default: "" },
            at: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    incidentId: { type: Schema.Types.ObjectId, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
runSchema.index({ workspaceId: 1, createdAt: -1 });
runSchema.index({ playbookId: 1, agentId: 1, createdAt: -1 });
runSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 86400 });

export const PlaybookRunModel = mongoose.model<IPlaybookRunDocument>("PlaybookRun", runSchema);

/* ------------------------------------------------------------------ */
/* Policy versions: history, proposals, rollback                       */
/* ------------------------------------------------------------------ */

export type PolicyVersionStatus = "applied" | "proposed" | "rejected" | "withdrawn";
export type PolicyVersionAction = "created" | "updated" | "deleted" | "rolled_back";

export interface IAgentPolicyVersion {
  workspaceId: Types.ObjectId | string;
  policyId: Types.ObjectId | string;
  version: number;
  action: PolicyVersionAction;
  status: PolicyVersionStatus;
  /** The policy after this change (null: deleted). */
  snapshot: object | null;
  /** The policy before it (for diffs and proposals). */
  previous: object | null;
  changedBy: Types.ObjectId | string;
  note?: string | null;
  reviewedBy?: Types.ObjectId | string | null;
  reviewedAt?: Date | null;
  createdAt: Date;
}

export interface IAgentPolicyVersionDocument extends IAgentPolicyVersion, Document {}

const policyVersionSchema = new Schema<IAgentPolicyVersionDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    policyId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    action: { type: String, enum: ["created", "updated", "deleted", "rolled_back"], required: true },
    status: { type: String, enum: ["applied", "proposed", "rejected", "withdrawn"], default: "applied" },
    snapshot: { type: Schema.Types.Mixed, default: null },
    previous: { type: Schema.Types.Mixed, default: null },
    changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
policyVersionSchema.index({ policyId: 1, version: -1 });
policyVersionSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

export const AgentPolicyVersionModel = mongoose.model<IAgentPolicyVersionDocument>("AgentPolicyVersion", policyVersionSchema);
