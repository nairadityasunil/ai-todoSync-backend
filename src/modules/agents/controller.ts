import type { Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import toolRegistry from "../mcp/registry/tool-registry.js";
import type { RiskLevel } from "../mcp/registry/tool-types.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { findMembership } from "../workspace/repositories/workspace-member.repository.js";
import {
  invalidateMaskingSetting,
  invalidateProviderAgents,
} from "./ai-governance.js";
import agentService, {
  ALL_AGENT_SCOPES,
  sanitizeScopes,
  STANDARD_AGENT_SCOPES,
} from "./agent.service.js";
import approvalService, { approverScope } from "./approval.service.js";
import {
  agentUsage,
  complianceReport,
  recomputeRisk,
  workspaceOverview,
} from "./governance.service.js";
import { invalidatePolicies, loadPolicies } from "./guard.js";
import {
  AgentActivityModel,
  AgentAlertModel,
  AgentModel,
  AgentPolicyModel,
  type IAgentDocument,
  type IPolicyMatch,
} from "./model.js";
import { evaluatePolicies, RISK_ORDER } from "./policy-engine.js";
import { POLICY_TEMPLATES } from "./policy-templates.js";
import { checkPrompt } from "./prompt-checks.js";
import { undoActivity } from "./undo.service.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const userIdOf = (req: AuthenticatedRequest): string => {
  const id = req.user?._id?.toString();
  if (!id) throw new AppError(401, "Authentication required", "AUTH_REQUIRED");
  return id;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const param = (req: AuthenticatedRequest, name: string): string => {
  const value = (req.params as Record<string, string | undefined>)[name];
  if (!value || !Types.ObjectId.isValid(value))
    throw new AppError(404, "Not found", "NOT_FOUND");
  return value;
};

/** Workspaces the user administers (OWNER/ADMIN). */
const adminWorkspaces = async (userId: string): Promise<Types.ObjectId[]> =>
  (await approverScope(userId)).workspaceIds;

/** The workspace a request is about: ?workspaceId, else the first one the user administers. */
const workspaceFor = async (
  req: AuthenticatedRequest,
  userId: string,
): Promise<Types.ObjectId | null> => {
  const requested =
    str(req.query.workspaceId) ??
    str((req.body as Record<string, unknown>)?.workspaceId);
  const admin = await adminWorkspaces(userId);
  if (requested) {
    const match = admin.find((id) => id.toString() === requested);
    if (!match)
      throw new AppError(
        403,
        "Only workspace owners and admins can do this",
        "FORBIDDEN",
      );
    return match;
  }
  return admin[0] ?? null;
};

const requireWorkspace = async (
  req: AuthenticatedRequest,
  userId: string,
): Promise<Types.ObjectId> => {
  const workspaceId = await workspaceFor(req, userId);
  if (!workspaceId)
    throw new AppError(
      403,
      "Only workspace owners and admins can do this",
      "FORBIDDEN",
    );
  return workspaceId;
};

/** Agents the user owns, plus every agent in workspaces they administer. */
const visibleAgentsFilter = async (userId: string) => {
  const admin = await adminWorkspaces(userId);
  return {
    $or: [
      { ownerUserId: new Types.ObjectId(userId) },
      { workspaceId: { $in: admin } },
    ],
  };
};

const loadManageableAgent = async (
  req: AuthenticatedRequest,
  userId: string,
): Promise<IAgentDocument> => {
  const agent = await AgentModel.findOne({
    _id: param(req, "agentId"),
    ...(await visibleAgentsFilter(userId)),
  });
  if (!agent) throw new AppError(404, "Agent not found", "NOT_FOUND");
  return agent;
};

interface AgentAccess {
  agent: IAgentDocument;
  /** The user the agent acts for (never true for workspace AI providers). */
  isOwner: boolean;
  /** Owner or admin of the agent's workspace. */
  isAdmin: boolean;
}

/**
 * An agent plus the caller's standing on it. Owners manage their own agents;
 * workspace admins can always narrow, suspend or revoke, and what an admin
 * locks only an admin can lift. AI provider agents belong to the workspace.
 */
const loadAgentAccess = async (
  req: AuthenticatedRequest,
  userId: string,
): Promise<AgentAccess> => {
  const agent = await loadManageableAgent(req, userId);
  const admin = await adminWorkspaces(userId);
  const isAdmin =
    agent.workspaceId != null &&
    admin.some((id) => id.equals(agent.workspaceId as Types.ObjectId));
  const isOwner =
    agent.kind !== "ai_provider" && agent.ownerUserId.toString() === userId;
  if (!isOwner && !isAdmin) {
    throw new AppError(
      403,
      "Only workspace owners and admins can manage this agent",
      "FORBIDDEN",
    );
  }
  return { agent, isOwner, isAdmin };
};

const sameIds = (ids: unknown[]): string[] => ids.map(String).sort();

/** True when `next` grants nothing that `current` did not. */
const isNarrowing = (
  current: { scopes: string[]; projectIds: unknown[]; expiresAt?: Date | null },
  next: { scopes?: string[]; projectIds?: string[]; expiresAt?: Date | null },
): boolean => {
  if (next.scopes && next.scopes.some((s) => !current.scopes.includes(s)))
    return false;
  if (next.projectIds) {
    const was = sameIds(current.projectIds);
    // [] means every project: widening unless it already was.
    if (next.projectIds.length === 0 && was.length > 0) return false;
    if (was.length > 0 && next.projectIds.some((id) => !was.includes(id)))
      return false;
  }
  if (next.expiresAt !== undefined && current.expiresAt) {
    if (!next.expiresAt || next.expiresAt > current.expiresAt) return false;
  }
  return true;
};

export const serializeAgent = (agent: IAgentDocument) => {
  const plain = agent.toObject
    ? agent.toObject()
    : (agent as unknown as Record<string, unknown>);
  const {
    keyHash: _keyHash,
    __v: _v,
    ...rest
  } = plain as Record<string, unknown>;
  return { ...rest, id: agent._id.toString() };
};

const parseDate = (value: unknown): Date | undefined => {
  const raw = str(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const RISKS = new Set<string>(RISK_ORDER);

const sanitizeMatch = (raw: unknown): IPolicyMatch => {
  const match = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const list = (value: unknown, max = 50) =>
    Array.isArray(value)
      ? value
          .map((item) => String(item).trim())
          .filter(Boolean)
          .slice(0, max)
      : undefined;
  const ids = (value: unknown) =>
    list(value)?.filter((id) => Types.ObjectId.isValid(id));
  const kinds = list(match.agentKinds)?.filter((kind) =>
    [
      "api_key",
      "mcp_client",
      "chatgpt",
      "companion",
      "ai_provider",
      "detected",
    ].includes(kind),
  );
  const window = match.timeWindow as Record<string, unknown> | undefined;
  const hour = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n)
      ? Math.min(24, Math.max(0, Math.round(n)))
      : fallback;
  };
  return {
    agentKinds: kinds as IPolicyMatch["agentKinds"],
    agentIds: ids(match.agentIds),
    tools: list(match.tools),
    domains: list(match.domains),
    minRisk: RISKS.has(String(match.minRisk))
      ? (match.minRisk as RiskLevel)
      : undefined,
    projectIds: ids(match.projectIds),
    timeWindow:
      window && typeof window === "object"
        ? {
            days: Array.isArray(window.days)
              ? window.days.map(Number).filter((d) => d >= 0 && d <= 6)
              : undefined,
            startHour: hour(window.startHour, 0),
            endHour: hour(window.endHour, 24),
            timezone: str(window.timezone) ?? "UTC",
            outside: Boolean(window.outside),
          }
        : undefined,
  };
};

const sanitizePolicy = (body: Record<string, unknown>) => {
  const name = str(body.name);
  if (!name) throw new AppError(400, "Policy name is required", "BAD_REQUEST");
  const effect = String(body.effect ?? "");
  if (!["allow", "deny", "require_approval"].includes(effect)) {
    throw new AppError(
      400,
      "effect must be allow, deny or require_approval",
      "BAD_REQUEST",
    );
  }
  const mode = body.mode === "enforce" ? "enforce" : "advisory";
  const priority = Number.isFinite(Number(body.priority))
    ? Math.round(Number(body.priority))
    : 100;
  return {
    name: name.slice(0, 120),
    description: (str(body.description) ?? "").slice(0, 500),
    effect,
    mode,
    priority: Math.max(0, Math.min(1000, priority)),
    enabled: body.enabled !== false,
    match: sanitizeMatch(body.match),
  };
};

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

class AgentController {
  public overview = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await workspaceFor(req, userId);
    const [stats, pendingApprovals, mine] = await Promise.all([
      workspaceId ? workspaceOverview([workspaceId]) : null,
      approvalService.countPending(userId),
      AgentModel.countDocuments({
        ownerUserId: userId,
        status: { $ne: "revoked" },
      }),
    ]);
    res.json({
      success: true,
      data: {
        workspaceId: workspaceId?.toString() ?? null,
        isAdmin: Boolean(workspaceId),
        stats,
        pendingApprovals,
        myAgents: mine,
      },
    });
  };

  public list = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const filter: Record<string, unknown> = {
      ...(await visibleAgentsFilter(userId)),
    };
    const workspaceId = str(req.query.workspaceId);
    // One workspace, plus the caller's own agents that belong to none.
    if (workspaceId && Types.ObjectId.isValid(workspaceId))
      filter.$and = [
        {
          $or: [
            { workspaceId: new Types.ObjectId(workspaceId) },
            { workspaceId: null, ownerUserId: new Types.ObjectId(userId) },
          ],
        },
      ];
    const kind = str(req.query.kind);
    if (kind) filter.kind = kind;
    const status = str(req.query.status);
    filter.status = status ?? { $ne: "revoked" };
    const risk = str(req.query.risk);
    if (risk) filter.riskLevel = risk;
    const q = str(req.query.q);
    if (q)
      filter.name = {
        $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    const agents = await AgentModel.find(filter)
      .sort({ riskScore: -1, lastSeenAt: -1 })
      .limit(500)
      .populate("ownerUserId", "name email");
    res.json({ success: true, data: agents.map(serializeAgent) });
  };

  public detail = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    let agent = await loadManageableAgent(req, userId);
    const stale =
      !agent.riskEvaluatedAt ||
      Date.now() - agent.riskEvaluatedAt.getTime() > 3600_000;
    if (stale || req.query.refresh === "1") agent = await recomputeRisk(agent);
    const [usage, owner] = await Promise.all([
      agentUsage(agent),
      agent.populate("ownerUserId", "name email"),
    ]);
    res.json({ success: true, data: { ...serializeAgent(owner), usage } });
  };

  public createKey = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestedWorkspace = str(body.workspaceId);
    // Keys may only be attached to a workspace the user belongs to.
    if (
      requestedWorkspace &&
      (!Types.ObjectId.isValid(requestedWorkspace) ||
        !(await findMembership(requestedWorkspace, userId)))
    ) {
      throw new AppError(
        403,
        "You are not a member of that workspace",
        "FORBIDDEN",
      );
    }
    const { agent, key } = await agentService.createApiKey({
      ownerUserId: userId,
      workspaceId: requestedWorkspace ?? null,
      name: String(body.name ?? ""),
      scopes: body.scopes,
      projectIds: body.projectIds,
      expiresAt: body.expiresAt,
    });
    await recomputeRisk(agent);
    res.status(201).json({
      success: true,
      message: "Copy this key now: it will not be shown again.",
      data: { agent: serializeAgent(agent), key },
    });
  };

  public update = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { agent, isOwner, isAdmin } = await loadAgentAccess(req, userId);
    if (agent.status === "revoked")
      throw new AppError(409, "This agent was revoked", "CONFLICT");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next: {
      scopes?: string[];
      projectIds?: string[];
      expiresAt?: Date | null;
    } = {};
    if (body.scopes !== undefined) {
      const canAdmin = await agentService.isWorkspaceAdminAnywhere(
        agent.ownerUserId.toString(),
      );
      let scopes = sanitizeScopes(body.scopes, STANDARD_AGENT_SCOPES);
      if (!canAdmin)
        scopes = scopes.filter((scope) => scope !== "workspace:admin");
      next.scopes = scopes;
    }
    if (body.projectIds !== undefined) {
      next.projectIds = Array.isArray(body.projectIds)
        ? [
            ...new Set(
              body.projectIds
                .map(String)
                .filter((id) => Types.ObjectId.isValid(id)),
            ),
          ]
        : [];
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = body.expiresAt ? parseDate(body.expiresAt) : null;
      if (body.expiresAt && !expiresAt)
        throw new AppError(400, "expiresAt must be a date", "BAD_REQUEST");
      next.expiresAt = expiresAt ?? null;
    }

    // An admin changing someone else's agent may only take access away, and
    // locks it so the owner cannot hand it back.
    const actingAsAdmin = !isOwner;
    const ownerLocked = isOwner && !isAdmin && agent.adminLocked;
    if ((actingAsAdmin || ownerLocked) && !isNarrowing(agent, next)) {
      throw new AppError(
        403,
        actingAsAdmin
          ? "Admins can only reduce another member's agent access"
          : "A workspace admin restricted this agent; you can only reduce its access",
        "FORBIDDEN",
      );
    }

    if (body.name !== undefined) {
      const name = str(body.name);
      if (!name) throw new AppError(400, "Name is required", "BAD_REQUEST");
      agent.name = name.slice(0, 120);
    }
    if (next.scopes) agent.scopes = next.scopes as IAgentDocument["scopes"];
    if (next.projectIds) agent.projectIds = next.projectIds;
    if (next.expiresAt !== undefined) agent.expiresAt = next.expiresAt;
    if (actingAsAdmin && Object.keys(next).length > 0) agent.adminLocked = true;
    await agent.save();
    agentService.invalidate(agent._id.toString());
    await recomputeRisk(agent);
    res.json({ success: true, data: serializeAgent(agent) });
  };

  public rotate = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { agent, isOwner } = await loadAgentAccess(req, userId);
    // A new secret authenticates as the owner, so only the owner may get one.
    if (!isOwner) {
      throw new AppError(
        403,
        "Only the key's owner can rotate it. Admins can suspend or revoke it.",
        "FORBIDDEN",
      );
    }
    if (agent.kind !== "api_key")
      throw new AppError(400, "Only agent keys can be rotated", "BAD_REQUEST");
    if (agent.status !== "active") {
      throw new AppError(
        409,
        `This agent is ${agent.status}; resume it before rotating its key`,
        "CONFLICT",
      );
    }
    const key = await agentService.rotateKey(agent);
    res.json({
      success: true,
      message:
        "The old key stopped working. Copy the new one now: it will not be shown again.",
      data: { agent: serializeAgent(agent), key },
    });
  };

  /**
   * Gives an unregistered agent its own key and retires the detected one, so
   * the script moves off the person's login. Only the person can do this:
   * the new key acts for them.
   */
  public replaceWithKey = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { agent, isOwner } = await loadAgentAccess(req, userId);
    if (agent.kind !== "detected")
      throw new AppError(
        400,
        "Only unregistered agents can be replaced with a key",
        "BAD_REQUEST",
      );
    if (!isOwner)
      throw new AppError(
        403,
        "Only the person whose login it uses can create its key. Admins can block it.",
        "FORBIDDEN",
      );
    if (agent.status === "revoked")
      throw new AppError(409, "This agent was already retired", "CONFLICT");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { agent: replacement, key } = await agentService.createApiKey({
      ownerUserId: userId,
      workspaceId: agent.workspaceId?.toString() ?? null,
      name: str(body.name) ?? agent.name,
      scopes: body.scopes ?? agent.scopes,
      projectIds: body.projectIds ?? agent.projectIds.map(String),
      expiresAt:
        body.expiresAt !== undefined
          ? body.expiresAt
          : new Date(Date.now() + 90 * 86400000).toISOString(),
    });
    agent.status = "revoked";
    agent.statusReason = `Replaced by the agent key "${replacement.name}"`;
    agent.replacedByAgentId = replacement._id;
    await agent.save();
    agentService.invalidate(agent._id.toString());
    await AgentAlertModel.updateMany(
      { agentId: agent._id, acknowledgedAt: null },
      { $set: { acknowledgedAt: new Date(), acknowledgedBy: userId } },
    );
    await recomputeRisk(replacement);
    res.status(201).json({
      success: true,
      message: "Copy this key now: it will not be shown again.",
      data: { agent: serializeAgent(replacement), key },
    });
  };

  private setStatus = async (
    req: AuthenticatedRequest,
    res: Response,
    status: "active" | "suspended" | "revoked",
  ) => {
    const userId = userIdOf(req);
    const { agent, isAdmin } = await loadAgentAccess(req, userId);
    if (agent.status === "revoked")
      throw new AppError(409, "This agent was revoked", "CONFLICT");
    if (status === "active" && agent.statusSetByAdmin && !isAdmin) {
      throw new AppError(
        403,
        "A workspace admin suspended this agent; only an admin can resume it",
        "FORBIDDEN",
      );
    }
    agent.status = status;
    agent.statusSetByAdmin = status === "active" ? false : isAdmin;
    agent.statusReason =
      status === "active"
        ? null
        : (str((req.body as Record<string, unknown>)?.reason)?.slice(0, 300) ??
          null);
    if (status === "revoked" && agent.kind === "api_key") agent.keyHash = null;
    await agent.save();
    agentService.invalidate(agent._id.toString());
    if (agent.kind === "ai_provider") invalidateProviderAgents();
    res.json({ success: true, data: serializeAgent(agent) });
  };

  public suspend = (req: AuthenticatedRequest, res: Response) =>
    this.setStatus(req, res, "suspended");
  public resume = (req: AuthenticatedRequest, res: Response) =>
    this.setStatus(req, res, "active");
  public revoke = (req: AuthenticatedRequest, res: Response) =>
    this.setStatus(req, res, "revoked");

  /** Emergency stop: suspends every active agent in a workspace. */
  public killSwitch = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const reason =
      str((req.body as Record<string, unknown>)?.reason) ?? "Emergency stop";
    const result = await AgentModel.updateMany(
      { workspaceId, status: "active" },
      {
        $set: {
          status: "suspended",
          statusReason: reason.slice(0, 300),
          statusSetByAdmin: true,
        },
      },
    );
    agentService.invalidate();
    invalidateProviderAgents();
    res.json({ success: true, data: { suspended: result.modifiedCount } });
  };

  /* ---------------------------- Activity ---------------------------- */

  public activity = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const filter: Record<string, unknown> = {};
    const agentId =
      str(req.query.agentId) ?? (req.params as Record<string, string>).agentId;
    if (agentId) {
      const agent = await AgentModel.findOne({
        _id: agentId,
        ...(await visibleAgentsFilter(userId)),
      })
        .select("_id")
        .lean();
      if (!agent) throw new AppError(404, "Agent not found", "NOT_FOUND");
      filter.agentId = agent._id;
    } else {
      const admin = await adminWorkspaces(userId);
      filter.$or = [
        { userId: new Types.ObjectId(userId) },
        { workspaceId: { $in: admin } },
      ];
      const workspaceId = str(req.query.workspaceId);
      if (workspaceId && Types.ObjectId.isValid(workspaceId))
        filter.workspaceId = new Types.ObjectId(workspaceId);
    }
    const outcome = str(req.query.outcome);
    if (outcome) filter.outcome = outcome;
    const risk = str(req.query.risk);
    if (risk) filter.risk = risk;
    const before = parseDate(req.query.before);
    if (before) filter.createdAt = { $lt: before };
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await AgentActivityModel.find(filter)
      .select("-undo.before")
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("agentId", "name kind")
      .lean();
    res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        id: row._id.toString(),
        undoable: Boolean(row.undo) && !row.undoneAt,
        undo: row.undo
          ? { entityType: row.undo.entityType, entityId: row.undo.entityId }
          : null,
      })),
    });
  };

  public undo = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const result = await undoActivity(param(req, "activityId"), userId);
    res.json({ success: true, data: result });
  };

  public exportActivity = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const from =
      parseDate(req.query.from) ?? new Date(Date.now() - 30 * 86400000);
    const to = parseDate(req.query.to) ?? new Date();
    const rows = await AgentActivityModel.find({
      workspaceId,
      createdAt: { $gte: from, $lte: to },
    })
      .select("-undo")
      .sort({ createdAt: -1 })
      .limit(50_000)
      .populate("agentId", "name kind")
      .lean();
    const stamp = new Date().toISOString().slice(0, 10);
    if (req.query.format === "csv") {
      const header = [
        "time",
        "agent",
        "kind",
        "channel",
        "action",
        "risk",
        "outcome",
        "status",
        "policy",
        "projectId",
        "userId",
        "approvalId",
        "error",
      ];
      const escape = (value: unknown) => {
        const text = value == null ? "" : String(value);
        const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const lines = rows.map((row) => {
        const agent = row.agentId as unknown as {
          name?: string;
          kind?: string;
        } | null;
        return [
          row.createdAt.toISOString(),
          agent?.name,
          agent?.kind,
          row.channel,
          row.action,
          row.risk,
          row.outcome,
          row.statusCode,
          row.policyName,
          row.projectId,
          row.userId,
          row.approvalId,
          row.error,
        ]
          .map(escape)
          .join(",");
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="agent-activity-${stamp}.csv"`,
      );
      res.send([header.join(","), ...lines].join("\n"));
      return;
    }
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="agent-activity-${stamp}.json"`,
    );
    res.json({
      success: true,
      data: { from, to, count: rows.length, activity: rows },
    });
  };

  /* ---------------------------- Policies ---------------------------- */

  public listPolicies = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const policies = await AgentPolicyModel.find({ workspaceId })
      .sort({ priority: -1, createdAt: 1 })
      .lean();
    res.json({
      success: true,
      data: policies.map((policy) => ({
        ...policy,
        id: policy._id.toString(),
      })),
    });
  };

  public policyTemplates = async (
    _req: AuthenticatedRequest,
    res: Response,
  ) => {
    res.json({ success: true, data: POLICY_TEMPLATES });
  };

  public createPolicy = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const policy = await AgentPolicyModel.create({
      ...sanitizePolicy((req.body ?? {}) as Record<string, unknown>),
      workspaceId,
      createdBy: userId,
      updatedBy: userId,
    });
    invalidatePolicies(workspaceId.toString());
    res.status(201).json({
      success: true,
      data: { ...policy.toObject(), id: policy._id.toString() },
    });
  };

  private loadPolicy = async (req: AuthenticatedRequest, userId: string) => {
    const admin = await adminWorkspaces(userId);
    const policy = await AgentPolicyModel.findOne({
      _id: param(req, "policyId"),
      workspaceId: { $in: admin },
    });
    if (!policy) throw new AppError(404, "Policy not found", "NOT_FOUND");
    return policy;
  };

  public updatePolicy = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const policy = await this.loadPolicy(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = sanitizePolicy({
      ...policy.toObject(),
      ...body,
      match: body.match ?? policy.match,
    });
    policy.set({ ...next, updatedBy: userId });
    await policy.save();
    invalidatePolicies(policy.workspaceId.toString());
    res.json({
      success: true,
      data: { ...policy.toObject(), id: policy._id.toString() },
    });
  };

  public deletePolicy = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const policy = await this.loadPolicy(req, userId);
    await policy.deleteOne();
    invalidatePolicies(policy.workspaceId.toString());
    res.json({ success: true, data: { deleted: true } });
  };

  /** Dry run: which policy would decide a given call, without doing anything. */
  public testPolicies = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = str(body.action);
    if (!action) throw new AppError(400, "action is required", "BAD_REQUEST");
    const tool = toolRegistry.getEntry(action);
    const risk = (
      RISKS.has(String(body.risk)) ? body.risk : (tool?.risk ?? "write")
    ) as RiskLevel;
    const agentId = str(body.agentId);
    const agent = agentId
      ? await AgentModel.findOne({ _id: agentId, workspaceId })
          .select("kind")
          .lean()
      : null;
    const policies = await loadPolicies(workspaceId.toString());
    const decision = evaluatePolicies(policies, {
      agentId: agentId ?? "",
      agentKind: (agent?.kind ??
        str(body.agentKind) ??
        "api_key") as IAgentDocument["kind"],
      action,
      domain: str(body.domain) ?? tool?.domain ?? action.split(":")[0],
      risk,
      projectId: str(body.projectId) ?? null,
      now: parseDate(body.at) ?? new Date(),
    });
    res.json({
      success: true,
      data: {
        effect: decision.effect,
        policy: decision.policy
          ? { id: decision.policy.id, name: decision.policy.name }
          : null,
        advisory: decision.advisory.map((policy) => ({
          id: policy.id,
          name: policy.name,
          effect: policy.effect,
        })),
        risk,
      },
    });
  };

  /** Tools and risk levels, for building policies. */
  public catalog = async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: {
        tools: toolRegistry.listManifest().map((tool) => ({
          name: tool.name,
          domain: tool.domain,
          risk: tool.risk,
          description: tool.description,
        })),
        risks: RISK_ORDER,
        scopes: ALL_AGENT_SCOPES,
        standardScopes: STANDARD_AGENT_SCOPES,
      },
    });
  };

  /* ---------------------------- Approvals --------------------------- */

  public listApprovals = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const approvals = await approvalService.list(userId, {
      status: str(req.query.status),
      limit: Number(req.query.limit) || 50,
    });
    res.json({
      success: true,
      data: approvals.map((a) => ({ ...a.toObject(), id: a._id.toString() })),
    });
  };

  public getApproval = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const approval = await approvalService.getForUser(
      param(req, "approvalId"),
      userId,
    );
    const data = approval.toObject() as Record<string, unknown>;
    // Agents polling their own request get the outcome, not the raw input.
    if (req.agent) delete data.input;
    res.json({ success: true, data: { ...data, id: approval._id.toString() } });
  };

  public approve = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const approval = await approvalService.approve(
      param(req, "approvalId"),
      userId,
      str((req.body as Record<string, unknown>)?.note),
    );
    res.json({
      success: true,
      data: { ...approval.toObject(), id: approval._id.toString() },
    });
  };

  public reject = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const approval = await approvalService.reject(
      param(req, "approvalId"),
      userId,
      str((req.body as Record<string, unknown>)?.note),
    );
    res.json({
      success: true,
      data: { ...approval.toObject(), id: approval._id.toString() },
    });
  };

  /* ----------------------------- Alerts ----------------------------- */

  public listAlerts = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    const mine = await AgentModel.find({ ownerUserId: userId })
      .select("_id")
      .lean();
    const filter: Record<string, unknown> = {
      $or: [
        { workspaceId: { $in: admin } },
        { agentId: { $in: mine.map((a) => a._id) } },
      ],
    };
    if (req.query.open === "1") filter.acknowledgedAt = null;
    const agentId = str(req.query.agentId);
    if (agentId && Types.ObjectId.isValid(agentId))
      filter.agentId = new Types.ObjectId(agentId);
    const alerts = await AgentAlertModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 300))
      .populate("agentId", "name kind")
      .lean();
    res.json({
      success: true,
      data: alerts.map((a) => ({ ...a, id: a._id.toString() })),
    });
  };

  public acknowledgeAlert = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const userId = userIdOf(req);
    const admin = await adminWorkspaces(userId);
    const mine = await AgentModel.find({ ownerUserId: userId })
      .select("_id")
      .lean();
    const alert = await AgentAlertModel.findOneAndUpdate(
      {
        _id: param(req, "alertId"),
        $or: [
          { workspaceId: { $in: admin } },
          { agentId: { $in: mine.map((a) => a._id) } },
        ],
      },
      { $set: { acknowledgedAt: new Date(), acknowledgedBy: userId } },
      { new: true },
    );
    if (!alert) throw new AppError(404, "Alert not found", "NOT_FOUND");
    res.json({
      success: true,
      data: { ...alert.toObject(), id: alert._id.toString() },
    });
  };

  /* --------------------------- Compliance --------------------------- */

  public compliance = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const report = await complianceReport(workspaceId.toString());
    if (req.query.download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="agent-governance-report-${report.generatedAt.slice(0, 10)}.json"`,
      );
    }
    res.json({ success: true, data: report });
  };

  public getSettings = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const workspace = await WorkspaceModel.findById(workspaceId)
      .select("settings name")
      .lean();
    res.json({
      success: true,
      data: {
        workspaceId: workspaceId.toString(),
        aiDataMasking: Boolean(workspace?.settings?.aiDataMasking),
        requireAgentKeys: Boolean(workspace?.settings?.requireAgentKeys),
        activityRetentionDays: 90,
      },
    });
  };

  public updateSettings = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.aiDataMasking === "boolean") {
      await WorkspaceModel.updateOne(
        { _id: workspaceId },
        { $set: { "settings.aiDataMasking": body.aiDataMasking } },
      );
      invalidateMaskingSetting(workspaceId.toString());
    }
    if (typeof body.requireAgentKeys === "boolean") {
      await WorkspaceModel.updateOne(
        { _id: workspaceId },
        { $set: { "settings.requireAgentKeys": body.requireAgentKeys } },
      );
      agentService.invalidate();
    }
    return this.getSettings(req, res);
  };

  public promptChecks = async (req: AuthenticatedRequest, res: Response) => {
    userIdOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
          .slice(0, 50)
          .map((m) => ({
            role: String(m.role ?? "user"),
            content: String(m.content ?? ""),
          }))
      : [];
    const findings = checkPrompt({
      body: typeof body.body === "string" ? body.body.slice(0, 20000) : "",
      messages,
      parameters:
        body.parameters && typeof body.parameters === "object"
          ? (body.parameters as { maxTokens?: number })
          : null,
    });
    res.json({
      success: true,
      data: { findings, blocking: findings.some((f) => f.severity === "high") },
    });
  };
}

export default new AgentController();
