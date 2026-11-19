import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

import type { TaskPriority } from "./task.model.js";

/** A project's own response and resolution times for one priority. Priorities without a row use the person's defaults. */
export interface IProjectSlaConfig {
  projectId: Types.ObjectId | string;
  priority: TaskPriority;
  responseTimeHours: number;
  resolutionTimeHours: number;
  updatedBy?: Types.ObjectId | string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IProjectSlaConfigDocument
  extends IProjectSlaConfig, Document {}

const projectSlaConfigSchema = new Schema<IProjectSlaConfigDocument>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Project",
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      required: true,
    },
    responseTimeHours: { type: Number, required: true, min: 0.01 },
    resolutionTimeHours: { type: Number, required: true, min: 0.01 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

projectSlaConfigSchema.index({ projectId: 1, priority: 1 }, { unique: true });

const ProjectSlaConfigModel = model<IProjectSlaConfigDocument>(
  "ProjectSlaConfig",
  projectSlaConfigSchema,
);

export default ProjectSlaConfigModel;
