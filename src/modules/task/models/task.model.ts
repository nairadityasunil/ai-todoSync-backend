import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export type TaskWorkflowStatus =
  | "BACKLOG"
  | "TODO"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "BLOCKED"
  | "DONE";
export type TaskStatus = TaskWorkflowStatus | "rolled_over";

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type TaskSlaState =
  | "HEALTHY"
  | "NEAR_BREACH"
  | "BREACHED"
  | "PAUSED"
  | "COMPLETED";

export interface ISubtask {
  _id?: any;
  title: string;
  description?: string;
  note?: string;
  status: TaskWorkflowStatus;
  completed: boolean;
  completedAt?: Date | null;
  assignedToUserId?: Types.ObjectId | string | null;
}

export interface ITask {
  userId: Types.ObjectId | string;
  title: string;
  description?: string;
  note?: string;
  date: string;
  status: TaskStatus;
  priority: TaskPriority;
  basePriority: TaskPriority;
  dynamicPriority: TaskPriority;
  urgencyScore: number;
  impactScore: number;
  dependencyWeight: number;
  dynamicPriorityScore: number;
  priorityEscalatedAt?: Date | null;
  priorityEscalationReason?: string;
  isBlocked: boolean;
  blockedByTaskId?: Types.ObjectId | string | null;
  order: number;
  rolledOver: boolean;
  rolloverCount: number;
  source?: string;
  estimatedHours?: number;
  projectId?: Types.ObjectId | string | null;
  epicId?: Types.ObjectId | string | null;
  assignedTo: Types.ObjectId | string;
  assignedBy?: Types.ObjectId | string | null;
  assignedAt?: Date;
  subtasks?: ISubtask[];
  slaResponseDueAt?: Date | null;
  slaResolutionDueAt?: Date | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
  firstResponseAt?: Date | null;
  completedAt?: Date | null;
  slaPausedAt?: Date | null;
  totalPausedDuration: number;
  currentSlaState: TaskSlaState;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ITaskDocument extends ITask, Document {}

const subtaskSchema = new Schema<ISubtask>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    note: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"],
      default: "TODO",
    },
    completed: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    assignedToUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { _id: true },
);

const taskSchema = new Schema<ITaskDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    note: {
      type: String,
      default: "",
    },
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    status: {
      type: String,
      enum: [
        "BACKLOG",
        "TODO",
        "IN_PROGRESS",
        "IN_REVIEW",
        "BLOCKED",
        "DONE",
        "rolled_over",
      ],
      default: "TODO",
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
    },
    basePriority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
    },
    dynamicPriority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
    },
    urgencyScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    impactScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    dependencyWeight: {
      type: Number,
      default: 0,
      min: 0,
    },
    dynamicPriorityScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    priorityEscalatedAt: {
      type: Date,
      default: null,
    },
    priorityEscalationReason: {
      type: String,
      default: "",
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    blockedByTaskId: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    order: {
      type: Number,
      default: 0,
    },
    rolledOver: {
      type: Boolean,
      default: false,
    },
    rolloverCount: {
      type: Number,
      default: 0,
    },
    source: {
      type: String,
      default: "manual",
    },
    estimatedHours: {
      type: Number,
      default: 8,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
    },
    epicId: {
      type: Schema.Types.ObjectId,
      ref: "Epic",
      default: null,
    },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    subtasks: {
      type: [subtaskSchema],
      default: [],
    },
    slaResponseDueAt: {
      type: Date,
      default: null,
    },
    slaResolutionDueAt: {
      type: Date,
      default: null,
    },
    responseBreached: {
      type: Boolean,
      default: false,
    },
    resolutionBreached: {
      type: Boolean,
      default: false,
    },
    firstResponseAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    slaPausedAt: {
      type: Date,
      default: null,
    },
    totalPausedDuration: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentSlaState: {
      type: String,
      enum: ["HEALTHY", "NEAR_BREACH", "BREACHED", "PAUSED", "COMPLETED"],
      default: "HEALTHY",
    },
  },
  { timestamps: true },
);

// Access-path indexes for task lists: by owner, project and assignee, each
// with date for the day view, plus epic and subtask-assignee lookups.
taskSchema.index({ userId: 1, date: 1 });
taskSchema.index({ projectId: 1, date: 1 });
taskSchema.index({ assignedTo: 1, date: 1 });
taskSchema.index({ epicId: 1 });
taskSchema.index({ "subtasks.assignedToUserId": 1 });
taskSchema.index({ status: 1 });
taskSchema.index({ responseBreached: 1, resolutionBreached: 1, priority: 1 });
taskSchema.index({ slaResponseDueAt: 1, slaResolutionDueAt: 1, status: 1 });
taskSchema.index({ blockedByTaskId: 1, status: 1 });
taskSchema.index({ dynamicPriorityScore: -1, dynamicPriority: 1 });

const TaskModel = model<ITaskDocument>("Task", taskSchema);

export default TaskModel;
