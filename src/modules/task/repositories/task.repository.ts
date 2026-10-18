import type { ClientSession } from "mongoose";

import TaskModel, {
  ISubtask,
  ITaskDocument,
  TaskPriority,
} from "../../../modules/task/models/task.model.js";
import type { TaskSlaState, TaskStatus } from "../models/task.model.js";
import {
  andRefMatches,
  buildRefInMatch,
  buildRefMatch,
  buildSafeRefMatch,
} from "../../../utils/mongo-ref.js";
import { escapeRegex } from "../../../utils/escape-regex.js";

export type TaskDocumentWithAssignee = ITaskDocument;

export interface CreateTaskPayload {
  userId: string;
  title: string;
  description?: string;
  note?: string;
  date: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  basePriority?: TaskPriority;
  dynamicPriority?: TaskPriority;
  urgencyScore?: number;
  impactScore?: number;
  dependencyWeight?: number;
  dynamicPriorityScore?: number;
  priorityEscalatedAt?: Date | null;
  priorityEscalationReason?: string;
  isBlocked?: boolean;
  blockedByTaskId?: string | null;
  order?: number;
  source?: string;
  projectId?: string | null;
  epicId?: string | null;
  assignedTo: string;
  assignedBy?: string | null;
  assignedAt?: Date;
  subtasks?: ISubtask[];
  slaResponseDueAt?: Date | null;
  slaResolutionDueAt?: Date | null;
  responseBreached?: boolean;
  resolutionBreached?: boolean;
  firstResponseAt?: Date | null;
  completedAt?: Date | null;
  slaPausedAt?: Date | null;
  totalPausedDuration?: number;
  currentSlaState?: TaskSlaState;
}

export interface UpdateTaskPayload {
  title?: string;
  description?: string;
  note?: string;
  date?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  basePriority?: TaskPriority;
  dynamicPriority?: TaskPriority;
  urgencyScore?: number;
  impactScore?: number;
  dependencyWeight?: number;
  dynamicPriorityScore?: number;
  priorityEscalatedAt?: Date | null;
  priorityEscalationReason?: string;
  isBlocked?: boolean;
  blockedByTaskId?: string | null;
  order?: number;
  projectId?: string | null;
  epicId?: string | null;
  assignedTo?: string;
  assignedBy?: string | null;
  assignedAt?: Date;
  subtasks?: ISubtask[];
  slaResponseDueAt?: Date | null;
  slaResolutionDueAt?: Date | null;
  responseBreached?: boolean;
  resolutionBreached?: boolean;
  firstResponseAt?: Date | null;
  completedAt?: Date | null;
  slaPausedAt?: Date | null;
  totalPausedDuration?: number;
  currentSlaState?: TaskSlaState;
}

export interface BulkAssignTasksPayload {
  taskIds: string[];
  assignedTo: string;
}

export const taskPopulateOptions = [
  { path: "assignedTo", select: "email name firstName lastName" },
  { path: "assignedBy", select: "email name firstName lastName" },
  {
    path: "subtasks.assignedToUserId",
    select: "email name firstName lastName",
  },
  { path: "blockedByTaskId", select: "title status" },
];

export const createTask = async (
  payload: CreateTaskPayload,
): Promise<TaskDocumentWithAssignee> =>
  TaskModel.create(payload).then((task) => task.populate(taskPopulateOptions));

export const getTasksByUser = async (
  userId: string,
  projectIds: string[],
  assigneeId?: string,
  search?: string,
): Promise<TaskDocumentWithAssignee[]> => {
  const filter: any = {
    $or: [
      buildRefMatch("userId", userId),
      buildRefInMatch("projectId", projectIds),
    ],
  };

  if (assigneeId) {
    const aid = assigneeId.toString();
    filter.$and = [
      {
        $or: [
          buildSafeRefMatch("assignedTo", aid),
          buildSafeRefMatch("subtasks.assignedToUserId", aid),
        ],
      },
    ];
  }

  if (search) {
    const searchRegex = { $regex: escapeRegex(search.trim()), $options: "i" };
    const searchFilter = {
      $or: [{ title: searchRegex }, { note: searchRegex }],
    };
    if (filter.$and) {
      filter.$and.push(searchFilter);
    } else {
      filter.$and = [searchFilter];
    }
  }

  return TaskModel.find(filter)
    .populate(taskPopulateOptions)
    .sort({ date: 1, _id: 1 })
    .exec();
};

export const updateTask = async (
  taskId: string,
  updates: UpdateTaskPayload,
): Promise<TaskDocumentWithAssignee | null> =>
  TaskModel.findByIdAndUpdate(taskId, updates, {
    new: true,
  })
    .populate(taskPopulateOptions)
    .exec();

export const getTaskByIdAndUser = async (
  taskId: string,
  userId: string,
  projectIds: string[],
): Promise<TaskDocumentWithAssignee | null> =>
  TaskModel.findOne({
    _id: taskId,
    $or: [
      buildRefMatch("userId", userId),
      buildRefInMatch("projectId", projectIds),
    ],
  })
    .populate(taskPopulateOptions)
    .exec();

export const getTaskById = async (
  taskId: string,
): Promise<TaskDocumentWithAssignee | null> =>
  TaskModel.findById(taskId).populate(taskPopulateOptions).exec();

export const deleteTask = async (taskId: string): Promise<boolean> => {
  const result = await TaskModel.deleteOne({ _id: taskId }).exec();
  return result.deletedCount !== undefined && result.deletedCount > 0;
};

export const getTasksByDate = async (
  userId: string,
  projectIds: string[],
  date: string,
  assigneeId?: string,
  search?: string,
): Promise<TaskDocumentWithAssignee[]> => {
  const filter: any = {
    date,
    $or: [
      buildRefMatch("userId", userId),
      buildRefInMatch("projectId", projectIds),
    ],
  };

  if (assigneeId) {
    const aid = assigneeId.toString();
    filter.$and = [
      {
        $or: [
          buildSafeRefMatch("assignedTo", aid),
          buildSafeRefMatch("subtasks.assignedToUserId", aid),
        ],
      },
    ];
  }

  if (search) {
    const searchRegex = { $regex: escapeRegex(search.trim()), $options: "i" };
    const searchFilter = {
      $or: [{ title: searchRegex }, { note: searchRegex }],
    };
    if (filter.$and) {
      filter.$and.push(searchFilter);
    } else {
      filter.$and = [searchFilter];
    }
  }

  return TaskModel.find(filter)
    .populate(taskPopulateOptions)
    .sort({ status: 1, _id: 1 })
    .exec();
};

export const getPendingTasksByDate = async (
  date: string,
): Promise<ITaskDocument[]> =>
  TaskModel.find({
    date,
    status: { $in: ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED"] },
  }).exec();

export const markTasksRolledOver = async (taskIds: string[]): Promise<void> => {
  if (!taskIds.length) {
    return;
  }

  await TaskModel.updateMany(
    { _id: { $in: taskIds } },
    { status: "rolled_over", rolledOver: true },
  ).exec();
};

export const clearTaskAssignmentsForUser = async (
  projectId: string,
  userId: string,
  session?: ClientSession,
): Promise<void> => {
  await TaskModel.updateMany(
    andRefMatches(
      buildRefMatch("projectId", projectId),
      buildRefMatch("assignedToUserId", userId),
    ),
    { $set: { assignedToUserId: null } },
    { session },
  ).exec();
};
