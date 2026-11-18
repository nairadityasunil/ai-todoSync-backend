import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

/** Time a person logged against a project, optionally on one task. One row per log. */
export interface ITimeEntry {
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  taskId?: Types.ObjectId | null;
  /** Calendar day, YYYY-MM-DD, in the logger's own week. */
  date: string;
  minutes: number;
  note?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ITimeEntryDocument extends ITimeEntry, Document {}

const timeEntrySchema = new Schema<ITimeEntryDocument>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    taskId: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    minutes: { type: Number, required: true, min: 1, max: 24 * 60 },
    note: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true },
);

timeEntrySchema.index({ projectId: 1, date: 1, userId: 1 });
timeEntrySchema.index({ projectId: 1, taskId: 1 });

export default model<ITimeEntryDocument>("TimeEntry", timeEntrySchema);
