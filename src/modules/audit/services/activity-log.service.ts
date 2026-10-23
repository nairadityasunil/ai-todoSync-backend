import ActivityLogModel, {
  type EntityType,
  type ActionType,
  type IFieldChange,
} from "../../../modules/audit/models/activity-log.model.js";
import ProjectModel from "../../project/models/project.model.js";
import logger from "../../../lib/logger.js";
import { createHash } from "crypto";
import projectService from "../../project/services/project.service.js";
import { currentAgent } from "../../agents/activity.service.js";

interface LogActivityParams {
  projectId: string;
  entityType: EntityType;
  entityId: string;
  entityName?: string;
  action: ActionType;
  userId: string;
  userName: string;
  changes?: IFieldChange[];
  description: string;
  metadata?: Record<string, unknown>;
  approvalId?: string | null;
}

interface GetActivitiesOptions {
  limit?: number;
  page?: number;
  entityType?: EntityType;
}

class ActivityLogService {
  async logActivity(params: LogActivityParams): Promise<void> {
    try {
      const [lastLog, policy] = await Promise.all([
        ActivityLogModel.findOne({ projectId: params.projectId })
          .sort({ sequence: -1 })
          .lean(),
        this.getRetentionPolicy(params.projectId),
      ]);
      const sequence = (lastLog?.sequence ?? 0) + 1;
      const retentionUntil = policy.legalHold
        ? null
        : new Date(Date.now() + policy.retentionDays * 24 * 60 * 60 * 1000);
      const previousHash = lastLog?.immutableHash ?? null;
      const immutableHash = this.hashActivity({
        projectId: params.projectId,
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        userId: params.userId,
        description: params.description,
        sequence,
        previousHash,
      });

      await ActivityLogModel.create({
        projectId: params.projectId,
        entityType: params.entityType,
        entityId: params.entityId,
        entityName: params.entityName,
        action: params.action,
        userId: params.userId,
        userName: params.userName,
        changes: params.changes ?? [],
        description: params.description,
        // Changes made by an agent carry who it was, for review and undo.
        metadata: currentAgent()
          ? { ...(params.metadata ?? {}), agent: currentAgent() }
          : (params.metadata ?? {}),
        approvalId: params.approvalId ?? null,
        sequence,
        previousHash,
        immutableHash,
        retentionUntil,
        legalHold: policy.legalHold,
      });
    } catch (error) {
      // Don't throw — activity logging should never break the main flow
      logger.error("Failed to log activity", error as Error);
    }
  }

  async getRetentionPolicy(projectId: string) {
    const project = await ProjectModel.findById(projectId).lean();
    const audit = project?.audit;

    return {
      projectId,
      retentionDays: audit?.retentionDays ?? 2555,
      legalHold: audit?.legalHold ?? false,
      updatedBy: audit?.updatedBy?.toString() ?? null,
      updatedAt: null,
    };
  }

  async updateRetentionPolicy(
    projectId: string,
    updatedBy: string,
    payload: { retentionDays?: unknown; legalHold?: unknown },
  ) {
    await projectService.assertProjectRole(updatedBy, projectId, "ADMIN");

    const retentionDays = Number(payload.retentionDays ?? 2555);
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 30 ||
      retentionDays > 3650
    ) {
      throw Object.assign(
        new Error("retentionDays must be between 30 and 3650"),
        {
          status: 400,
        },
      );
    }

    const legalHold =
      typeof payload.legalHold === "boolean" ? payload.legalHold : false;

    const project = await ProjectModel.findByIdAndUpdate(
      projectId,
      {
        $set: {
          "audit.retentionDays": retentionDays,
          "audit.legalHold": legalHold,
          "audit.updatedBy": updatedBy,
        },
      },
      { new: true },
    ).lean();

    return {
      projectId,
      retentionDays: project?.audit?.retentionDays ?? retentionDays,
      legalHold: project?.audit?.legalHold ?? legalHold,
      updatedBy,
      updatedAt: new Date().toISOString(),
    };
  }

  async verifyAuditChain(projectId: string) {
    const logs = await ActivityLogModel.find({ projectId })
      .sort({ sequence: 1 })
      .lean();

    let previousHash: string | null = null;
    for (const log of logs) {
      if (!log.immutableHash || !log.sequence) {
        return {
          valid: false,
          checked: logs.length,
          failedSequence: log.sequence ?? null,
          reason:
            "Audit log missing immutable hash or sequence. Run audit migration.",
        };
      }

      const expected = this.hashActivity({
        projectId: log.projectId,
        entityType: log.entityType,
        entityId: log.entityId,
        action: log.action,
        userId: log.userId,
        description: log.description,
        sequence: log.sequence,
        previousHash,
      });

      if (log.previousHash !== previousHash || log.immutableHash !== expected) {
        return {
          valid: false,
          checked: logs.length,
          failedSequence: log.sequence,
          reason: "Audit chain hash mismatch",
        };
      }

      previousHash = log.immutableHash;
    }

    return {
      valid: true,
      checked: logs.length,
      failedSequence: null,
      reason: null,
    };
  }

  async getProjectActivities(
    projectId: string,
    options: GetActivitiesOptions = {},
  ) {
    const { limit = 50, page = 1, entityType } = options;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = { projectId };
    if (entityType) {
      filter.entityType = entityType;
    }

    const [activities, total] = await Promise.all([
      ActivityLogModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityLogModel.countDocuments(filter),
    ]);

    return {
      activities: activities.map((a) => ({
        id: a._id.toString(),
        projectId: a.projectId,
        entityType: a.entityType,
        entityId: a.entityId,
        entityName: a.entityName,
        action: a.action,
        userId: a.userId,
        userName: a.userName,
        changes: a.changes,
        description: a.description,
        metadata: a.metadata ?? {},
        immutableHash: a.immutableHash ?? "",
        previousHash: a.previousHash ?? null,
        sequence: a.sequence ?? 0,
        retentionUntil: a.retentionUntil?.toISOString() ?? null,
        legalHold: a.legalHold,
        approvalId: a.approvalId ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  private hashActivity(input: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }
}

const activityLogService = new ActivityLogService();
export default activityLogService;
