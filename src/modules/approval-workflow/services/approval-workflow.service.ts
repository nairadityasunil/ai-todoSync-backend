import ApprovalWorkflowModel, {
  type ApprovalAction,
  type ApprovalStatus,
} from "../../../modules/approval-workflow/models/approval-workflow.model.js";
import ProjectMemberModel from "../../project/models/project-member.model.js";
import TaskModel, { type TaskPriority } from "../../task/models/task.model.js";
import activityLogService from "../../audit/services/activity-log.service.js";
import projectService from "../../project/services/project.service.js";
import { andRefMatches, buildRefMatch } from "../../../utils/mongo-ref.js";

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class ApprovalWorkflowService {
  public async createApproval(
    actorUserId: string,
    payload: {
      projectId?: unknown;
      taskId?: unknown;
      action?: unknown;
      reason?: unknown;
      approverUserIds?: unknown;
      payload?: unknown;
    },
  ) {
    const projectId = this.requiredString(payload.projectId, "projectId");
    await projectService.assertProjectRole(actorUserId, projectId, "MEMBER");
    const approverUserIds = this.normalizeApprovers(payload.approverUserIds);

    for (const approverUserId of approverUserIds) {
      const isMember = await ProjectMemberModel.exists(
        andRefMatches(
          buildRefMatch("projectId", projectId),
          buildRefMatch("userId", approverUserId),
        ),
      );
      if (!isMember) {
        throw new HttpError(400, "All approvers must be project members");
      }
    }

    const workflow = await ApprovalWorkflowModel.create({
      projectId,
      taskId: this.optionalString(payload.taskId),
      requestedBy: actorUserId,
      action: this.normalizeAction(payload.action),
      status: "PENDING",
      payload:
        typeof payload.payload === "object" && payload.payload
          ? payload.payload
          : {},
      reason: typeof payload.reason === "string" ? payload.reason.trim() : "",
      signOffChain: approverUserIds.map((approverUserId, index) => ({
        order: index + 1,
        approverUserId,
        status: "PENDING" as ApprovalStatus,
      })),
    });

    await activityLogService.logActivity({
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "created",
      userId: actorUserId,
      userName: "System",
      description: `requested approval for ${workflow.action}`,
      approvalId: workflow._id.toString(),
      metadata: { action: workflow.action, taskId: workflow.taskId },
    });

    return this.toDto(workflow);
  }

  public async listApprovals(userId: string, projectId: string) {
    await projectService.assertProjectRole(userId, projectId, "MEMBER");
    const workflows = await ApprovalWorkflowModel.find({
      ...buildRefMatch("projectId", projectId),
    })
      .sort({ createdAt: -1 })
      .lean();

    return workflows.map((workflow) => this.toDto(workflow));
  }

  public async decide(
    actorUserId: string,
    approvalId: string,
    payload: { decision?: unknown; note?: unknown },
  ) {
    const workflow = await ApprovalWorkflowModel.findById(approvalId).exec();
    if (!workflow) {
      throw new HttpError(404, "Approval workflow not found");
    }

    await projectService.assertProjectRole(
      actorUserId,
      workflow.projectId.toString(),
      "MEMBER",
    );

    if (workflow.status !== "PENDING") {
      throw new HttpError(400, "Approval workflow already completed");
    }

    const currentStep = workflow.signOffChain
      .sort((left, right) => left.order - right.order)
      .find((step) => step.status === "PENDING");

    if (!currentStep) {
      throw new HttpError(400, "Approval workflow has no pending step");
    }

    if (currentStep.approverUserId.toString() !== actorUserId) {
      throw new HttpError(
        403,
        "Current sign-off step belongs to another approver",
      );
    }

    const decision = payload.decision === "REJECTED" ? "REJECTED" : "APPROVED";
    currentStep.status = decision;
    currentStep.decidedAt = new Date();
    currentStep.note =
      typeof payload.note === "string" ? payload.note.trim() : "";

    if (decision === "REJECTED") {
      workflow.status = "REJECTED";
      workflow.completedAt = new Date();
    } else if (
      workflow.signOffChain.every((step) => step.status === "APPROVED")
    ) {
      workflow.status = "APPROVED";
      workflow.completedAt = new Date();
      await this.applyApprovedAction(workflow);
    }

    await workflow.save();

    await activityLogService.logActivity({
      projectId: workflow.projectId.toString(),
      entityType: workflow.taskId ? "task" : "project",
      entityId: workflow.taskId?.toString() ?? workflow.projectId.toString(),
      action: decision === "APPROVED" ? "approved" : "rejected",
      userId: actorUserId,
      userName: "System",
      description: `${decision.toLowerCase()} ${workflow.action}`,
      approvalId: workflow._id.toString(),
      metadata: { action: workflow.action, finalStatus: workflow.status },
    });

    return this.toDto(workflow);
  }

  private async applyApprovedAction(workflow: any): Promise<void> {
    if (
      (workflow.action === "PRIORITY_CHANGE" ||
        workflow.action === "DYNAMIC_PRIORITY_ESCALATION") &&
      workflow.taskId &&
      typeof workflow.payload?.priority === "string"
    ) {
      const priority = workflow.payload.priority as TaskPriority;
      await TaskModel.updateOne(
        { _id: workflow.taskId },
        {
          priority,
          dynamicPriority: priority,
          priorityEscalatedAt: new Date(),
          priorityEscalationReason:
            typeof workflow.reason === "string"
              ? workflow.reason
              : "Approved priority change",
        },
      ).exec();
    }
  }

  private normalizeAction(value: unknown): ApprovalAction {
    const actions: ApprovalAction[] = [
      "PRIORITY_CHANGE",
      "DYNAMIC_PRIORITY_ESCALATION",
      "RETENTION_POLICY_CHANGE",
      "LEGAL_HOLD_CHANGE",
    ];
    if (
      typeof value !== "string" ||
      !actions.includes(value as ApprovalAction)
    ) {
      throw new HttpError(400, "Invalid approval action");
    }

    return value as ApprovalAction;
  }

  private normalizeApprovers(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new HttpError(400, "At least one approver is required");
    }

    return value.map((entry) => this.requiredString(entry, "approverUserId"));
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(400, `${field} is required`);
    }

    return value.trim();
  }

  private optionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private toDto(workflow: any) {
    return {
      id: workflow._id.toString(),
      projectId: workflow.projectId.toString(),
      taskId: workflow.taskId?.toString() ?? null,
      requestedBy: workflow.requestedBy.toString(),
      action: workflow.action,
      status: workflow.status,
      payload: workflow.payload ?? {},
      reason: workflow.reason,
      signOffChain: (workflow.signOffChain ?? []).map((step: any) => ({
        order: step.order,
        approverUserId: step.approverUserId.toString(),
        status: step.status,
        decidedAt: step.decidedAt?.toISOString() ?? null,
        note: step.note ?? "",
      })),
      completedAt: workflow.completedAt?.toISOString() ?? null,
      createdAt: workflow.createdAt?.toISOString() ?? null,
      updatedAt: workflow.updatedAt?.toISOString() ?? null,
    };
  }
}

export default new ApprovalWorkflowService();
