import mongoose, { type Document, Schema } from "mongoose";

export type EntityType = "project" | "epic" | "task" | "subtask" | "note";
export type ActionType =
  | "created"
  | "updated"
  | "deleted"
  | "assigned"
  | "status_changed"
  | "member_added"
  | "member_removed"
  | "approved"
  | "rejected"
  | "escalated";

export interface IFieldChange {
  field: string;
  oldValue?: string;
  newValue?: string;
}

export interface IActivityLog {
  projectId: string;
  entityType: EntityType;
  entityId: string;
  entityName?: string;
  action: ActionType;
  userId: string;
  userName: string;
  changes: IFieldChange[];
  description: string;
  metadata?: Record<string, unknown>;
  immutableHash: string;
  previousHash?: string | null;
  sequence: number;
  retentionUntil?: Date | null;
  legalHold: boolean;
  approvalId?: string | null;
  createdAt: Date;
}

export interface IActivityLogDocument extends IActivityLog, Document {}

const fieldChangeSchema = new Schema<IFieldChange>(
  {
    field: { type: String, required: true },
    oldValue: { type: String },
    newValue: { type: String },
  },
  { _id: false },
);

const activityLogSchema = new Schema<IActivityLogDocument>(
  {
    projectId: { type: String, required: true, index: true },
    entityType: {
      type: String,
      required: true,
      enum: ["project", "epic", "task", "subtask", "note"],
    },
    entityId: { type: String, required: true },
    entityName: { type: String },
    action: {
      type: String,
      required: true,
      enum: [
        "created",
        "updated",
        "deleted",
        "assigned",
        "status_changed",
        "member_added",
        "member_removed",
        "approved",
        "rejected",
        "escalated",
      ],
    },
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    changes: { type: [fieldChangeSchema], default: [] },
    description: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    immutableHash: { type: String, default: "", index: true },
    previousHash: { type: String, default: null },
    sequence: { type: Number, default: 0, index: true },
    retentionUntil: { type: Date, default: null, index: true },
    legalHold: { type: Boolean, default: false, index: true },
    approvalId: { type: String, default: null, index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

activityLogSchema.index({ projectId: 1, createdAt: -1 });
activityLogSchema.index({ entityType: 1, entityId: 1 });
activityLogSchema.index({ projectId: 1, sequence: -1 });
// Active people per day, and one person's activity (admin analytics, member timeline).
activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ userId: 1, createdAt: -1 });

activityLogSchema.pre("updateOne", { query: true, document: false }, () => {
  throw new Error(
    "Activity logs are immutable and cannot be modified or deleted",
  );
});

activityLogSchema.pre("findOneAndUpdate", () => {
  throw new Error(
    "Activity logs are immutable and cannot be modified or deleted",
  );
});

activityLogSchema.pre("deleteOne", { query: true, document: false }, () => {
  throw new Error(
    "Activity logs are immutable and cannot be modified or deleted",
  );
});

activityLogSchema.pre("findOneAndDelete", () => {
  throw new Error(
    "Activity logs are immutable and cannot be modified or deleted",
  );
});

const ActivityLogModel = mongoose.model<IActivityLogDocument>(
  "ActivityLog",
  activityLogSchema,
);

export default ActivityLogModel;
