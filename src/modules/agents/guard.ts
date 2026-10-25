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
  /** Already resolved by the caller (REST); otherwise read from `input`. */
  projectId?: string | null;
  resolvedProjects?: ProjectResolution;
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

export interface ProjectResolution {
  /** The project of the record being changed (null: personal or none). */
  projectId: string | null;
  /** Every project the call touches, e.g. both ends of a move. */
  touched: Array<string | null>;
}

/**
 * Works out which projects a call touches. The task or epic named in the
 * call decides the project; a supplied projectId is trusted alone only when
 * no such record is named, and otherwise counts as a second project touched
 * (a move), so a caller cannot claim one project while changing another.
 */
export async function resolveProjectId(refs: {
  projectId?: unknown;
  taskId?: unknown;
  epicId?: unknown;
}): Promise<ProjectResolution> {
  const claimed = asId(refs.projectId);
  const owners: Array<string | null> = [];
  const epicId = asId(refs.epicId);
  if (epicId) {
    const epic = await EpicModel.findById(epicId).select("projectId").lean();
    if (epic) owners.push(epic.projectId ? epic.projectId.toString() : null);
  }
  const taskId = asId(refs.taskId);
  if (taskId) {
    const task = await TaskModel.findById(taskId).select("projectId").lean();
    if (task) owners.push(task.projectId ? task.projectId.toString() : null);
  }
  if (owners.length === 0) return { projectId: claimed, touched: [claimed] };
  const touched = [...new Set([...owners, ...(claimed ? [claimed] : [])])];
  return { projectId: owners[0], touched };
}

const STRICTNESS = { allow: 0, require_approval: 1, deny: 2 } as const;

export async function authorize(
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  const { agent } = input;
  const workspaceId = agent.workspaceId ? agent.workspaceId.toString() : null;
  const resolved: ProjectResolution = input.resolvedProjects
    ? input.resolvedProjects
    : input.projectId !== undefined
      ? { projectId: input.projectId, touched: [input.projectId] }
      : await resolveProjectId({
          projectId: input.input.projectId,
          taskId: input.input.taskId,
          epicId: input.input.epicId,
        });
  const { projectId } = resolved;

  // Project allowlist: a scoped agent can only change its own projects, and
  // every project a call touches must be one of them.
  const allowed = (agent.projectIds ?? []).map(String);
  if (allowed.length > 0) {
    const outside = resolved.touched.some((touched) =>
      touched ? !allowed.includes(touched) : riskRank(input.risk) > 0,
    );
    if (outside) {
      return {
        effect: "deny",
        policy: null,
        advisory: [],
        projectId,
        reason: resolved.touched.some(Boolean)
          ? "This agent is not allowed to access that project."
          : "This agent is limited to specific projects; include a projectId.",
      };
    }
  }

  // Policies are checked for each project touched; the strictest result wins.
  const policies = await loadPolicies(workspaceId);
  const decisions = resolved.touched.map((touched) =>
    evaluatePolicies(policies, {
      agentId: agent._id.toString(),
      agentKind: agent.kind,
      action: input.action,
      domain: input.domain,
      risk: input.risk,
      projectId: touched,
    }),
  );
  const decision = decisions.reduce((worst, next) =>
    STRICTNESS[next.effect] > STRICTNESS[worst.effect] ? next : worst,
  );
  decision.advisory = [
    ...new Map(
      decisions.flatMap((d) => d.advisory).map((p) => [p.id, p]),
    ).values(),
  ];

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
