import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import EpicModel from "../epic/models/epic.model.js";
import type { RiskLevel } from "../mcp/registry/tool-types.js";
import TaskModel from "../task/models/task.model.js";
import activityService from "./activity.service.js";
import {
  AgentApprovalModel,
  AgentPolicyModel,
  type AgentUndoSnapshot,
  type IAgentApprovalDocument,
  type IAgentDocument,
} from "./model.js";
import {
  evaluatePolicies,
  riskRank,
  type PolicyLike,
} from "./policy-engine.js";
import { redactInput } from "./redaction.js";

/**
 * Single decision point for everything an agent does, over MCP or REST:
 * project allowlist first, then the workspace's policies.
 */

export const APPROVAL_TTL_MS = 24 * 3600 * 1000;
const POLICY_CACHE_TTL_MS = 30_000;

export interface AuthorizeInput {
  agent: IAgentDocument;
  userId: string;
  channel: "mcp" | "rest";
  action: string;
  domain: string;
  risk: RiskLevel;
  input: Record<string, unknown>;
  projectId?: string | null;
  request?: { method: string; path: string } | null;
  /** Calls that cannot wait (interactive AI) are denied instead of held. */
  noHold?: boolean;
}

export type AuthorizeResult =
  | {
      effect: "allow";
      policy: PolicyLike | null;
      advisory: PolicyLike[];
      projectId: string | null;
    }
  | {
      effect: "deny";
      policy: PolicyLike | null;
      advisory: PolicyLike[];
      projectId: string | null;
      reason: string;
    }
  | {
      effect: "require_approval";
      policy: PolicyLike;
      advisory: PolicyLike[];
      projectId: string | null;
      approval: IAgentApprovalDocument;
    };

const policyCache = new Map<string, { policies: PolicyLike[]; at: number }>();

export function invalidatePolicies(workspaceId?: string): void {
  if (workspaceId) policyCache.delete(workspaceId);
  else policyCache.clear();
}

export async function loadPolicies(
  workspaceId: string | null,
): Promise<PolicyLike[]> {
  if (!workspaceId) return [];
  const cached = policyCache.get(workspaceId);
  if (cached && Date.now() - cached.at < POLICY_CACHE_TTL_MS)
    return cached.policies;
  const docs = await AgentPolicyModel.find({
    workspaceId,
    enabled: true,
  }).lean();
  const policies: PolicyLike[] = docs.map((doc) => ({
    id: doc._id.toString(),
    name: doc.name,
    effect: doc.effect,
    mode: doc.mode,
    priority: doc.priority,
    enabled: doc.enabled,
    match: {
      ...doc.match,
      agentIds: doc.match?.agentIds?.map(String),
      projectIds: doc.match?.projectIds?.map(String),
    },
  }));
  policyCache.set(workspaceId, { policies, at: Date.now() });
  return policies;
}

const asId = (value: unknown): string | null => {
  const id =
    typeof value === "string"
      ? value.trim()
      : value != null
        ? String(value)
        : "";
  return id && Types.ObjectId.isValid(id) ? id : null;
};

/** Works out which project a call touches from the ids it carries. */
export async function resolveProjectId(refs: {
  projectId?: unknown;
  taskId?: unknown;
  epicId?: unknown;
}): Promise<string | null> {
  const projectId = asId(refs.projectId);
  if (projectId) return projectId;
  const epicId = asId(refs.epicId);
  if (epicId) {
    const epic = await EpicModel.findById(epicId).select("projectId").lean();
    if (epic?.projectId) return epic.projectId.toString();
  }
  const taskId = asId(refs.taskId);
  if (taskId) {
    const task = await TaskModel.findById(taskId).select("projectId").lean();
    if (task?.projectId) return task.projectId.toString();
  }
  return null;
}

export async function authorize(
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  const { agent } = input;
  const workspaceId = agent.workspaceId ? agent.workspaceId.toString() : null;
  const projectId =
    input.projectId ??
    (await resolveProjectId({
      projectId: input.input.projectId,
      taskId: input.input.taskId,
      epicId: input.input.epicId,
    }));

  // Project allowlist: a scoped agent can only change its own projects.
  const allowed = (agent.projectIds ?? []).map(String);
  if (allowed.length > 0) {
    const outside = projectId
      ? !allowed.includes(projectId)
      : riskRank(input.risk) > 0;
    if (outside) {
      return {
        effect: "deny",
        policy: null,
        advisory: [],
        projectId,
        reason: projectId
          ? "This agent is not allowed to access that project."
          : "This agent is limited to specific projects; include a projectId.",
      };
    }
  }

  const policies = await loadPolicies(workspaceId);
  const decision = evaluatePolicies(policies, {
    agentId: agent._id.toString(),
    agentKind: agent.kind,
    action: input.action,
    domain: input.domain,
    risk: input.risk,
    projectId,
  });

  if (decision.effect === "allow") {
    return {
      effect: "allow",
      policy: decision.policy,
      advisory: decision.advisory,
      projectId,
    };
  }
  if (decision.effect === "deny") {
    return {
      effect: "deny",
      policy: decision.policy,
      advisory: decision.advisory,
      projectId,
      reason: `Blocked by policy "${decision.policy?.name}".`,
    };
  }

  const policy = decision.policy as PolicyLike;
  if (input.noHold) {
    return {
      effect: "deny",
      policy,
      advisory: decision.advisory,
      projectId,
      reason: `Policy "${policy.name}" requires approval, which this kind of call cannot wait for.`,
    };
  }
  const approval = await AgentApprovalModel.create({
    workspaceId,
    projectId,
    agentId: agent._id,
    ownerUserId: input.userId,
    channel: input.channel,
    action: input.action,
    domain: input.domain,
    risk: input.risk,
    input: input.input,
    inputPreview: redactInput(input.input),
    request: input.request ?? null,
    policyId: policy.id,
    policyName: policy.name,
    status: "pending",
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
  });
  logger.info("Agent action held for approval", {
    agentId: agent._id.toString(),
    approvalId: approval._id.toString(),
    action: input.action,
  });
  return {
    effect: "require_approval",
    policy,
    advisory: decision.advisory,
    projectId,
    approval,
  };
}

/** Records the decision for the activity log. */
export function recordDecision(
  input: AuthorizeInput,
  result: AuthorizeResult,
  extra: {
    statusCode?: number | null;
    error?: string | null;
    durationMs?: number | null;
    undo?: AgentUndoSnapshot | null;
  } = {},
): void {
  activityService.record({
    agent: input.agent,
    userId: input.userId,
    channel: input.channel,
    action: input.action,
    domain: input.domain,
    risk: input.risk,
    input: input.input,
    projectId: result.projectId,
    outcome:
      result.effect === "allow"
        ? extra.error
          ? "error"
          : "allowed"
        : result.effect === "deny"
          ? "blocked"
          : "pending_approval",
    policy: result.policy,
    advisory: result.advisory,
    approvalId:
      result.effect === "require_approval"
        ? result.approval._id.toString()
        : null,
    ...extra,
  });
}
