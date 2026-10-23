import { randomBytes } from "node:crypto";

import { Types } from "mongoose";

import env from "../../config/env.js";
import logger from "../../lib/logger.js";
import { AppError } from "../../utils/app-error.js";
import UserModel, { type IUserDocument } from "../auth/models/user.model.js";
import toolRegistry from "../mcp/registry/tool-registry.js";
import ProjectMemberModel from "../project/models/project-member.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import activityService, { runAsAgent } from "./activity.service.js";
import { hashKey } from "./agent.service.js";
import {
  AgentApprovalModel,
  AgentModel,
  type IAgentApprovalDocument,
  type IAgentDocument,
} from "./model.js";

/**
 * Human-in-the-loop approvals. An approved action runs once, straight away,
 * as the agent that asked for it; the agent reads the outcome with
 * agent_approval_status (MCP) or GET /api/agents/approvals/:id (REST).
 */

const MAX_RESULT_CHARS = 20_000;

const compactResult = (value: unknown): unknown => {
  try {
    const json = JSON.stringify(value ?? null);
    if (json.length <= MAX_RESULT_CHARS) return JSON.parse(json);
    return { truncated: true, preview: json.slice(0, MAX_RESULT_CHARS) };
  } catch {
    return { unserializable: true };
  }
};

/** Workspaces a user administers, and projects they are an admin of. */
export async function approverScope(
  userId: string,
): Promise<{ workspaceIds: Types.ObjectId[]; projectIds: Types.ObjectId[] }> {
  const [workspaces, projects] = await Promise.all([
    WorkspaceMemberModel.find({ userId, role: { $in: ["OWNER", "ADMIN"] } })
      .select("workspaceId")
      .lean(),
    ProjectMemberModel.find({ userId, role: "ADMIN" })
      .select("projectId")
      .lean(),
  ]);
  return {
    workspaceIds: workspaces.map(
      (m) => new Types.ObjectId(m.workspaceId.toString()),
    ),
    projectIds: projects.map((m) => new Types.ObjectId(m.projectId.toString())),
  };
}

export async function canDecide(
  userId: string,
  approval: IAgentApprovalDocument,
): Promise<boolean> {
  const scope = await approverScope(userId);
  const inWorkspace =
    approval.workspaceId != null &&
    scope.workspaceIds.some((id) =>
      id.equals(approval.workspaceId as Types.ObjectId),
    );
  const inProject =
    approval.projectId != null &&
    scope.projectIds.some((id) =>
      id.equals(approval.projectId as Types.ObjectId),
    );
  // Without a workspace (personal use) the agent's owner is the only approver.
  const personal =
    approval.workspaceId == null && approval.ownerUserId.toString() === userId;
  return inWorkspace || inProject || personal;
}

class AgentApprovalService {
  public async list(
    userId: string,
    filter: { status?: string; limit?: number },
  ): Promise<IAgentApprovalDocument[]> {
    const scope = await approverScope(userId);
    const query: Record<string, unknown> = {
      $or: [
        { workspaceId: { $in: scope.workspaceIds } },
        { projectId: { $in: scope.projectIds } },
        // Owners always see what their own agents are waiting on.
        { ownerUserId: new Types.ObjectId(userId) },
      ],
    };
    if (filter.status) query.status = filter.status;
    return AgentApprovalModel.find(query)
      .select("-input -replayTokenHash")
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
      .populate("agentId", "name kind")
      .populate("ownerUserId", "name email")
      .populate("decidedBy", "name email")
      .exec();
  }

  public async countPending(userId: string): Promise<number> {
    const scope = await approverScope(userId);
    return AgentApprovalModel.countDocuments({
      status: "pending",
      expiresAt: { $gt: new Date() },
      $or: [
        { workspaceId: { $in: scope.workspaceIds } },
        { projectId: { $in: scope.projectIds } },
        { workspaceId: null, ownerUserId: new Types.ObjectId(userId) },
      ],
    });
  }

  /** Status as seen by the agent's owner (or an approver). */
  public async getForUser(
    approvalId: string,
    userId: string,
  ): Promise<IAgentApprovalDocument> {
    if (!Types.ObjectId.isValid(approvalId)) {
      throw new AppError(404, "Approval not found", "NOT_FOUND");
    }
    const approval =
      await AgentApprovalModel.findById(approvalId).select("-replayTokenHash");
    if (!approval) throw new AppError(404, "Approval not found", "NOT_FOUND");
    if (
      approval.ownerUserId.toString() !== userId &&
      !(await canDecide(userId, approval))
    ) {
      throw new AppError(404, "Approval not found", "NOT_FOUND");
    }
    return approval;
  }

  public async reject(approvalId: string, userId: string, note?: string) {
    const approval = await this.claim(approvalId, userId, "rejected", note);
    activityService.record({
      agent: (await AgentModel.findById(approval.agentId)) as IAgentDocument,
      userId: approval.ownerUserId.toString(),
      channel: approval.channel,
      action: approval.action,
      domain: approval.domain,
      risk: approval.risk,
      input: approval.input,
      projectId: approval.projectId?.toString() ?? null,
      outcome: "blocked",
      approvalId,
      error: "Rejected by an approver",
    });
    return this.getForUser(approvalId, userId);
  }

  public async approve(approvalId: string, userId: string, note?: string) {
    const approval = await this.claim(approvalId, userId, "approved", note);
    const [agent, owner] = await Promise.all([
      AgentModel.findById(approval.agentId),
      UserModel.findById(approval.ownerUserId),
    ]);
    if (!agent || !owner || agent.status !== "active") {
      await this.finish(
        approval,
        "failed",
        null,
        "The agent is no longer active.",
      );
      return this.getForUser(approvalId, userId);
    }
    const started = Date.now();
    try {
      const result =
        approval.channel === "mcp"
          ? await this.runTool(approval, agent)
          : await this.replayRest(approval);
      await this.finish(approval, "executed", result, null);
      activityService.record({
        agent,
        userId: owner._id.toString(),
        channel: approval.channel,
        action: approval.action,
        domain: approval.domain,
        risk: approval.risk,
        input: approval.input,
        projectId: approval.projectId?.toString() ?? null,
        outcome: "allowed",
        approvalId,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(approval, "failed", null, message);
      activityService.record({
        agent,
        userId: owner._id.toString(),
        channel: approval.channel,
        action: approval.action,
        domain: approval.domain,
        risk: approval.risk,
        input: approval.input,
        projectId: approval.projectId?.toString() ?? null,
        outcome: "error",
        approvalId,
        error: message,
        durationMs: Date.now() - started,
      });
    }
    return this.getForUser(approvalId, userId);
  }

  /** Marks pending approvals past their deadline as expired. */
  public async expireStale(): Promise<number> {
    const result = await AgentApprovalModel.updateMany(
      { status: "pending", expiresAt: { $lte: new Date() } },
      { $set: { status: "expired" } },
    );
    return result.modifiedCount;
  }

  /**
   * Consumes the one-time token on a replayed REST call. Returns the agent and
   * owner the call runs as, or null when the token is unknown or spent.
   */
  public async consumeReplayToken(
    token: string,
    method: string,
    path: string,
  ): Promise<{
    approval: IAgentApprovalDocument;
    agent: IAgentDocument;
    user: IUserDocument;
  } | null> {
    const approval = await AgentApprovalModel.findOneAndUpdate(
      { replayTokenHash: hashKey(token), status: "approved" },
      { $set: { replayTokenHash: null } },
      { new: true },
    );
    if (!approval?.request) return null;
    if (approval.request.method !== method || approval.request.path !== path)
      return null;
    const [agent, user] = await Promise.all([
      AgentModel.findById(approval.agentId),
      UserModel.findById(approval.ownerUserId),
    ]);
    if (!agent || !user) return null;
    return { approval, agent, user };
  }

  /* ------------------------------------------------------------------ */

  private async claim(
    approvalId: string,
    userId: string,
    status: "approved" | "rejected",
    note?: string,
  ): Promise<IAgentApprovalDocument> {
    const current = await this.getForUser(approvalId, userId);
    if (!(await canDecide(userId, current))) {
      throw new AppError(
        403,
        "Only workspace or project admins can decide on this request",
        "FORBIDDEN",
      );
    }
    const claimed = await AgentApprovalModel.findOneAndUpdate(
      { _id: approvalId, status: "pending", expiresAt: { $gt: new Date() } },
      {
        $set: {
          status,
          decidedBy: userId,
          decidedAt: new Date(),
          note: note ? String(note).slice(0, 500) : null,
        },
      },
      { new: true },
    );
    if (!claimed) {
      throw new AppError(
        409,
        current.status === "pending"
          ? "This request has expired"
          : `This request is already ${current.status}`,
        "CONFLICT",
      );
    }
    return claimed;
  }

  private async finish(
    approval: IAgentApprovalDocument,
    status: "executed" | "failed",
    result: unknown,
    error: string | null,
  ): Promise<void> {
    await AgentApprovalModel.updateOne(
      { _id: approval._id },
      {
        $set: {
          status,
          result: compactResult(result),
          error,
          replayTokenHash: null,
        },
      },
    );
  }

  private async runTool(
    approval: IAgentApprovalDocument,
    agent: IAgentDocument,
  ): Promise<unknown> {
    const entry = toolRegistry.getEntry(approval.action);
    if (!entry) throw new Error(`Tool "${approval.action}" no longer exists`);
    const input = { ...approval.input };
    delete input._confirmationToken;
    return runAsAgent(agent, () =>
      entry.handler(approval.ownerUserId.toString(), input),
    );
  }

  /** Re-sends the held REST call to this server with a one-time token. */
  private async replayRest(approval: IAgentApprovalDocument): Promise<unknown> {
    if (!approval.request) throw new Error("The held request is missing");
    const token = randomBytes(32).toString("base64url");
    await AgentApprovalModel.updateOne(
      { _id: approval._id },
      { $set: { replayTokenHash: hashKey(token) } },
    );
    const { method, path } = approval.request;
    const hasBody =
      !["GET", "HEAD", "DELETE"].includes(method) ||
      Object.keys(approval.input).length > 0;
    const response = await fetch(
      `http://127.0.0.1:${env.PORT || 5000}${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          "x-agent-replay": token,
        },
        body: hasBody ? JSON.stringify(approval.input) : undefined,
      },
    );
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!response.ok) {
      const message =
        (body as { message?: string; error?: string })?.message ??
        (body as { error?: string })?.error ??
        `Request failed with status ${response.status}`;
      logger.warn("Approved agent request failed on replay", {
        approvalId: approval._id.toString(),
        status: response.status,
      });
      throw new Error(String(message));
    }
    return body;
  }
}

export default new AgentApprovalService();
