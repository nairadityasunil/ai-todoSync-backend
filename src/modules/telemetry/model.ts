import mongoose, { Schema, type Document, type Types } from "mongoose";

import type { AutomationRule } from "./automation.js";

/** Links a condition the system found to the task it opened for it. */
export interface IAutomationLink {
  workspaceId?: Types.ObjectId | string | null;
  /** Who the task was given to. */
  userId: Types.ObjectId | string;
  rule: AutomationRule;
  key: string;
  taskId: Types.ObjectId | string;
  projectId?: Types.ObjectId | string | null;
  title: string;
  link: string;
  /** open: condition holds and the task is not done; done: the task is done; cleared: the condition went away. */
  state: "open" | "done" | "cleared";
  /** How the task ended: a person finished it, or the system closed it because the condition cleared. */
  closedBy?: "person" | "system" | null;
  closedAt?: Date | null;
  escalatedAt?: Date | null;
  metric?: {
    name: string;
    unit: "percent" | "score" | "count";
    value: number;
    lowerIsBetter: boolean;
  } | null;
  context: Record<string, string>;
  /** Feedback loop: the metric measured again some days after the task was done. */
  remeasureAt?: Date | null;
  remeasureTries: number;
  result?: {
    value: number;
    measuredAt: Date;
    outcome: "improved" | "worse" | "unchanged";
    sample: number;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAutomationLinkDocument extends IAutomationLink, Document {}

const schema = new Schema<IAutomationLinkDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, required: true },
    rule: { type: String, required: true },
    key: { type: String, required: true },
    taskId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, required: true },
    link: { type: String, default: "" },
    state: { type: String, enum: ["open", "done", "cleared"], default: "open" },
    closedBy: { type: String, enum: ["person", "system", null], default: null },
    closedAt: { type: Date, default: null },
    escalatedAt: { type: Date, default: null },
    metric: { type: Schema.Types.Mixed, default: null },
    context: { type: Schema.Types.Mixed, default: {} },
    remeasureAt: { type: Date, default: null },
    remeasureTries: { type: Number, default: 0 },
    result: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

schema.index({ key: 1, state: 1 });
schema.index({ workspaceId: 1, createdAt: -1 });
schema.index({ userId: 1, createdAt: -1 });
schema.index({ taskId: 1 });
schema.index({ remeasureAt: 1 }, { sparse: true });

export const AutomationLinkModel = mongoose.model<IAutomationLinkDocument>(
  "AutomationLink",
  schema,
);
