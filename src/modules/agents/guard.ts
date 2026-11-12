import { storedPolicyId } from "./policy-engine.js";
import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import EpicModel from "../epic/models/epic.model.js";
import type { RiskLevel } from "../mcp/registry/tool-types.js";
import TaskModel from "../task/models/task.model.js";
import activityService, { raiseAlert } from "./activity.service.js";
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
import { consume } from "./rate-limit.js";
import {
  defaultDecision,
  dlpVerdict,
  isBulkRead,
  maxTier,
  recommend,
  scanForDlp,
  tierFor,
  type DlpFinding,
  type RiskTier,
} from "./hybrid.js";
import { ANOMALY_RULES, labelVerdict, type Classification } from "./advanced.js";
import { assessAnomaly, assessSession, classificationFor, observeCorrelation } from "./advanced.service.js";
import {
  governanceSettings,
  handleThreats,
  openIncident,
  threatWindows,
} from "./hybrid.service.js";
import { AgentAlertModel } from "./model.js";
import { VendorModel } from "../vendors/model.js";
import { redactInput } from "./redaction.js";
import webhookService from "./webhooks.service.js";
import vendorService from "../vendors/service.js";

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
  /**
   * A person must approve this call even when no policy asks for it (an agent
   * changing agent governance). Policies can still deny it outright.
   */
  alwaysHold?: boolean;
  /** Caller's IP address, for threat detection (one key used from many places). */
  ip?: string | null;
  /** Caller's country, when a trusted proxy reports it (session risk). */
  country?: string | null;
  /** The task the call names, for its data label. */
  taskId?: string | null;
  /** Content sent on (e.g. an AI prompt), scanned by DLP but never stored. */
  content?: unknown;
}

/** How the system (not a policy) decided, recorded in the activity log as "System decided". */
export interface SystemDecision {
  decidedBy: "policy" | "system";
  rule?: string | null;
  tier?: string | null;
  dlp?: DlpFinding[];
  /** Label of the data touched. */
  classification?: string | null;
  /** Why the call was riskier than usual: baseline deviations, session signals. */
  signals?: string[];
}

const builtin = (id: string, name: string): PolicyLike => ({
  id: `builtin:${id}`,
  name,
  effect: "require_approval",
  mode: "enforce",
  priority: Number.MAX_SAFE_INTEGER,
  enabled: true,
  match: {} as PolicyLike["match"],
});
export const DLP_POLICY = builtin("dlp", "Data loss prevention");
export const REAPPROVAL_POLICY = builtin("reapproval", "Re-approval required after an incident");
export const VENDOR_POLICY = builtin("vendor", "Vendor agents: every change needs a person");
export const ANOMALY_POLICY = builtin("anomaly", "Far from the agent's usual behaviour");
export const SESSION_POLICY = builtin("session", "Unusual session: sensitive actions need a person");
export const LABEL_POLICY = builtin("classification", "Data classification");
const defaultRulePolicy = (rule: string): PolicyLike => builtin("default", rule);

const hostCache = new Map<string, { hosts: string[]; at: number }>();
/** Hosts agents may send links to: the portal and approved vendors' websites. */
async function approvedHosts(workspaceId: string | null): Promise<string[]> {
  const key = workspaceId ?? "";
  const hit = hostCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.hosts;
  const own = [process.env.FRONTEND_URL, process.env.APP_URL, "localhost"]
    .filter((v): v is string => Boolean(v))
    .map((v) => { try { return new URL(v.includes("://") ? v : `https://${v}`).hostname; } catch { return v; } });
  const vendors = workspaceId
    ? await VendorModel.find({ workspaceId, status: "approved", website: { $ne: null } }).select("website").lean()
    : [];
  const hosts = [
    ...own,
    ...vendors.map((v) => { try { return new URL(String(v.website).includes("://") ? String(v.website) : `https://${v.website}`).hostname.replace(/^www\./, ""); } catch { return ""; } }),
  ].filter(Boolean);
  hostCache.set(key, { hosts, at: Date.now() });
  return hosts;
}

/** The built-in rule behind `alwaysHold`: agents never change governance on their own. */
export const GOVERNANCE_HOLD_POLICY: PolicyLike = {
  id: "builtin:governance",
  name: "Agent changes to governance need a person",
  effect: "require_approval",
  mode: "enforce",
  priority: Number.MAX_SAFE_INTEGER,
  enabled: true,
  match: {} as PolicyLike["match"],
};

export type AuthorizeResult =
  | {
      effect: "allow";
      policy: PolicyLike | null;
      advisory: PolicyLike[];
      projectId: string | null;
      system?: SystemDecision;
    }
  | {
      effect: "deny";
      policy: PolicyLike | null;
      advisory: PolicyLike[];
      projectId: string | null;
      reason: string;
      /** Set when the agent is over its rate limit (respond 429). */
      retryAfterSec?: number;
      system?: SystemDecision;
    }
  | {
      effect: "require_approval";
      policy: PolicyLike;
      advisory: PolicyLike[];
      projectId: string | null;
      approval: IAgentApprovalDocument;
      system?: SystemDecision;
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
  const result = await decide(input);
  // Related actions by several agents (reads included) form one incident.
  // Only actions that go ahead count: held or blocked attempts are not access.
  if (result.effect === "allow") {
    void observeCorrelation({
      agent: input.agent,
      action: input.action,
      risk: input.risk,
      projectId: result.projectId,
      isBulk: Boolean(input.request && isBulkRead(input.request.method, input.request.path)),
    }).catch(() => undefined);
  }
  return result;
}

async function decide(
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  const { agent } = input;
  const workspaceId = agent.workspaceId ? agent.workspaceId.toString() : null;

  // Rate limit first: an agent over its limit gets nothing else evaluated.
  if (agent.rateLimitPerMinute) {
    const rate = await consume(agent._id.toString(), agent.rateLimitPerMinute);
    if (!rate.allowed) {
      // Alert on the first call over the limit; at most once an hour.
      if (rate.count === agent.rateLimitPerMinute + 1) {
        void raiseAlert({
          workspaceId,
          agentId: agent._id.toString(),
          type: "rate_limited",
          severity: "warning",
          title: `${agent.name} hit its rate limit`,
          detail: `More than ${agent.rateLimitPerMinute} calls in a minute; further calls were refused until the minute ended.`,
          dedupeKey: `rate_limited:${agent._id}:${Math.floor(Date.now() / 3600_000)}`,
        }).catch(() => undefined);
      }
      return {
        effect: "deny",
        policy: null,
        advisory: [],
        projectId: input.projectId ?? null,
        reason: `Rate limit reached: ${agent.rateLimitPerMinute} calls per minute. Try again in ${rate.retryAfterSec}s.`,
        retryAfterSec: rate.retryAfterSec,
      };
    }
  }
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

  // Third-party status: blocked or restricted vendors limit their agents.
  const vendorDecision = await vendorService.decide(agent, input.risk);
  if (vendorDecision) {
    return {
      effect: "deny",
      policy: null,
      advisory: [],
      projectId: input.projectId ?? null,
      reason: vendorDecision.deny,
    };
  }

  // Third-party agents must be limited to specific projects.
  const isVendor = agent.operatedBy === "vendor";
  if (isVendor && (agent.projectIds ?? []).length === 0) {
    return {
      effect: "deny",
      policy: null,
      advisory: [],
      projectId: input.projectId ?? null,
      reason: "Blocked: agents used by a third party must be limited to specific projects.",
    };
  }

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

  const settings = await governanceSettings(workspaceId);
  const taskId = input.taskId ?? (typeof input.input.taskId === "string" ? input.input.taskId : null);
  const classification = await classificationFor({ projectIds: resolved.touched, taskId }).catch(() => "internal" as Classification);

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
      classification,
      operatedBy: isVendor ? "vendor" : "internal",
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

  const isRead = input.risk === "read";
  // A shadow agent scores critical for using a person's login; its writes wait for a person
  // (the shadow AI settings decide whether it is blocked), rather than being suspended outright.
  const agentRiskLevel = agent.kind === "detected" && agent.riskLevel === "critical" ? "high" : agent.riskLevel;
  // Context that raises an action's risk: the data's label, the agent's own
  // baseline and the session it is used from.
  const strictLabel = settings.classificationEnforce && (classification === "confidential" || classification === "restricted");
  const [anomaly, session] = await Promise.all([
    assessAnomaly(agent, { action: input.action, risk: input.risk, projectId }, settings).catch(() => null),
    assessSession(agent, input.ip, input.country, settings).catch(() => null),
  ]);
  const labelBoost = strictLabel ? labelVerdict({ label: classification, risk: input.risk, toModel: false, leaves: false, dlpFindings: 0 }).boost : null;
  const sessionBoost = session && !isRead ? session.boost : null;
  const tier = tierFor({
    risk: input.risk,
    agentRiskLevel,
    boost: maxTier(...([labelBoost, anomaly?.boost, sessionBoost].filter(Boolean) as RiskTier[])),
  });
  const signals = [
    ...(anomaly?.reasons ?? []),
    ...(session && !isRead ? session.reasons : []),
    ...(strictLabel ? [`${classification[0].toUpperCase()}${classification.slice(1)} data`] : []),
  ];
  let system: SystemDecision = { decidedBy: decision.policy ? "policy" : "system", tier, classification, signals };
  const deny = (reason: string, sys: SystemDecision): AuthorizeResult => ({
    effect: "deny",
    policy: decision.policy,
    advisory: decision.advisory,
    projectId,
    reason,
    system: sys,
  });

  // Compliance enforcement: keys past their maximum age may only read.
  if (
    settings.complianceEnforce &&
    !isRead &&
    agent.kind === "api_key" &&
    settings.keyMaxAgeDays > 0
  ) {
    const issued = (agent.keyIssuedAt ?? (agent as unknown as { createdAt?: Date }).createdAt) as Date | undefined;
    if (issued && Date.now() - new Date(issued).getTime() > settings.keyMaxAgeDays * 86_400_000) {
      return deny(`Blocked by compliance: this agent key is older than ${settings.keyMaxAgeDays} days. Rotate it to continue.`, {
        decidedBy: "system",
        tier,
        rule: "Compliance: key expiration",
      });
    }
  }

  // Safety net: while an agent is deleting in bulk, further deletes are refused.
  if (input.risk === "destructive" && settings.threatDetection && threatWindows.deletingInBulk(agent._id.toString())) {
    return deny("Blocked: this agent is deleting in bulk. A person must review it first.", {
      decidedBy: "system",
      tier: "critical",
      rule: "Threat: mass delete",
    });
  }

  // Data loss prevention: secrets and personal data in what the agent sends, and bulk exports.
  let dlp: DlpFinding[] = [];
  if (settings.dlpMode !== "off" || strictLabel) {
    dlp = scanForDlp(input.content !== undefined ? [input.input, input.content] : input.input, { allowedHosts: await approvedHosts(workspaceId) });
    if (input.request && isBulkRead(input.request.method, input.request.path)) {
      dlp.push({ type: "bulk_export", label: "Bulk data export", confidence: "medium", count: 1 });
    }
  }
  if (settings.dlpMode !== "off") {
    if (dlp.length) {
      system = { ...system, dlp };
      void raiseAlert({
        workspaceId,
        agentId: agent._id.toString(),
        type: "dlp",
        severity: dlp.some((f) => f.confidence === "high") ? "critical" : "warning",
        title: `Sensitive data in ${agent.name}'s ${input.action}`,
        detail: dlp.map((f) => `${f.label}${f.count > 1 ? ` (${f.count})` : ""}`).join(", ") + (settings.dlpMode === "monitor" ? ". Monitor mode: allowed and logged." : "."),
        dedupeKey: `dlp:${agent._id}:${input.action}:${Math.floor(Date.now() / 600_000)}`,
      }).catch(() => undefined);
    }
    // Secrets are enforced everywhere; personal data only when it leaves Pristine
    // (AI calls, bulk exports, links out). Ordinary work data is monitored.
    const leavesPristine = input.domain === "ai" || dlp.some((f) => f.type === "bulk_export" || f.type === "external_destination");
    const enforceable = dlp.filter((f) => f.confidence === "high" || leavesPristine);
    const verdict = dlpVerdict(settings.dlpMode, enforceable);
    if (verdict.effect === "deny") {
      return deny(verdict.reason as string, { decidedBy: "system", tier, rule: "Data loss prevention", dlp });
    }
    if (verdict.effect === "require_approval" && decision.effect !== "deny") {
      decision.effect = "require_approval";
      decision.policy = DLP_POLICY;
      system = { decidedBy: "system", tier, rule: verdict.reason, dlp };
    }
  }

  // Labelled data: confidential and restricted content does not leave Pristine,
  // whatever the policies say.
  if (strictLabel) {
    const verdict = labelVerdict({
      label: classification,
      risk: input.risk,
      toModel: input.domain === "ai",
      leaves: dlp.some((f) => f.type === "bulk_export" || f.type === "external_destination"),
      dlpFindings: dlp.filter((f) => f.type !== "bulk_export" && f.type !== "external_destination").length,
    });
    if (verdict.effect === "deny") {
      return deny(verdict.reason as string, { ...system, decidedBy: "system", rule: `Data classification: ${classification}`, dlp });
    }
    if (verdict.effect === "require_approval" && decision.effect === "allow") {
      decision.effect = "require_approval";
      decision.policy = LABEL_POLICY;
      system = { ...system, decidedBy: "system", rule: verdict.reason, dlp };
    }
  }

  // Safety nets (enforce modes): far from its baseline, or an unusual session
  // for a sensitive action, the call waits for a person even if a policy allows it.
  if (decision.effect === "allow" && !isRead && settings.mode !== "advisory") {
    if (anomaly && anomaly.score >= ANOMALY_RULES.highScore) {
      decision.effect = "require_approval";
      decision.policy = ANOMALY_POLICY;
      system = { ...system, decidedBy: "system", rule: `${ANOMALY_POLICY.name}: ${anomaly.reasons[0] ?? "deviation"}` };
    } else if (session?.level === "high" && riskRank(input.risk) >= riskRank("write")) {
      decision.effect = "require_approval";
      decision.policy = SESSION_POLICY;
      system = { ...system, decidedBy: "system", rule: `${SESSION_POLICY.name} (${session.reasons.join("; ")})` };
    }
  }

  // After an incident a person must approve the agent's next change.
  if (agent.reapprovalRequired && !isRead && decision.effect === "allow") {
    decision.effect = "require_approval";
    decision.policy = REAPPROVAL_POLICY;
    system = { ...system, decidedBy: "system", rule: REAPPROVAL_POLICY.name };
  }

  if (decision.effect === "allow" && input.alwaysHold) {
    decision.effect = "require_approval";
    decision.policy = GOVERNANCE_HOLD_POLICY;
    system = { ...system, decidedBy: "system", rule: GOVERNANCE_HOLD_POLICY.name };
  }

  // Third-party agents: every change waits for a person unless a policy explicitly allows it.
  if (isVendor && !isRead && decision.effect === "allow" && !decision.policy) {
    decision.effect = "require_approval";
    decision.policy = VENDOR_POLICY;
    system = { ...system, decidedBy: "system", rule: VENDOR_POLICY.name };
  }

  // No explicit policy: the default rule for the action's risk tier decides.
  if (decision.effect === "allow" && !decision.policy) {
    const rule = defaultDecision(settings, tier, isRead);
    system = { ...system, decidedBy: "system", rule: rule.rule, tier };
    if (rule.wouldHave) {
      decision.advisory = [...decision.advisory, { ...defaultRulePolicy(rule.rule), effect: rule.wouldHave, mode: "advisory" }];
    }
    if (rule.effect === "deny") {
      if (rule.suspend) {
        await openIncident({
          workspaceId,
          agents: [agent],
          trigger: "critical_risk",
          severity: "critical",
          title: `${agent.name} tried a critical-risk action`,
          summary: `${input.action} was blocked and ${agent.name} suspended until a person reviews it (${agent.riskLevel} agent risk).`,
          action: input.action,
          contain: true,
        });
      }
      return deny(`Blocked: ${rule.rule}.`, system);
    }
    if (rule.effect === "require_approval") {
      decision.effect = "require_approval";
      decision.policy = defaultRulePolicy(rule.rule);
    }
  }

  // Auto-approve repeats: a person approved the same action for this agent recently.
  if (
    decision.effect === "require_approval" &&
    settings.autoApproveRepeatDays > 0 &&
    decision.policy?.id !== DLP_POLICY.id &&
    decision.policy?.id !== REAPPROVAL_POLICY.id &&
    decision.policy?.id !== ANOMALY_POLICY.id &&
    decision.policy?.id !== SESSION_POLICY.id &&
    decision.policy?.id !== LABEL_POLICY.id &&
    !isVendor &&
    !input.noHold
  ) {
    const since = new Date(Date.now() - settings.autoApproveRepeatDays * 86_400_000);
    const earlier = await AgentApprovalModel.findOne({
      agentId: agent._id,
      action: input.action,
      status: { $in: ["approved", "executed"] },
      decidedBySystem: { $ne: true },
      decidedAt: { $gte: since },
    })
      .select("decidedAt")
      .lean();
    if (earlier) {
      return {
        effect: "allow",
        policy: decision.policy,
        advisory: decision.advisory,
        projectId,
        system: {
          ...system,
          decidedBy: "system",
          rule: `Auto-approved: a person approved ${input.action} for this agent within the last ${settings.autoApproveRepeatDays} day(s)`,
        },
      };
    }
  }

  if (decision.effect === "allow") {
    return {
      effect: "allow",
      policy: decision.policy,
      advisory: decision.advisory,
      projectId,
      system,
    };
  }
  if (decision.effect === "deny") {
    return {
      effect: "deny",
      policy: decision.policy,
      advisory: decision.advisory,
      projectId,
      reason: `Blocked by policy "${decision.policy?.name}".`,
      system,
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
      system,
    };
  }
  const recentWindow = new Date(Date.now() - 30 * 86_400_000);
  const [approvedBefore, rejectedBefore, threatSignals] = await Promise.all([
    AgentApprovalModel.countDocuments({ agentId: agent._id, action: input.action, status: { $in: ["approved", "executed"] }, decidedAt: { $gte: recentWindow } }),
    AgentApprovalModel.countDocuments({ agentId: agent._id, action: input.action, status: "rejected", decidedAt: { $gte: recentWindow } }),
    AgentAlertModel.countDocuments({ agentId: agent._id, type: "threat", createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
  ]);
  const recommendation = recommend({
    tier: (system.tier as never) ?? tier,
    risk: input.risk,
    agentRiskLevel: agent.riskLevel,
    agentKind: agent.kind,
    approvedBefore,
    rejectedBefore,
    dlpFindings: (system.dlp ?? []).length,
    threatSignals,
    signals,
  });
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
    policyId: storedPolicyId(policy),
    policyName: policy.name,
    status: "pending",
    tier: system.tier ?? tier,
    recommendation,
    dlp: system.dlp ?? [],
    classification,
    signals,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
  });
  webhookService.emit({
    type: "approval.requested",
    workspaceId,
    summary: `${agent.name} wants to run ${input.action}: approval needed under policy "${policy.name}"`,
    data: {
      approvalId: approval._id.toString(),
      agentId: agent._id.toString(),
      agentName: agent.name,
      action: input.action,
      risk: input.risk,
      policy: policy.name,
      projectId,
      expiresAt: approval.expiresAt,
      input: approval.inputPreview,
      recommendation,
    },
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
    system,
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
    decidedBy: result.system?.decidedBy ?? (result.policy ? "policy" : null),
    rule: result.system?.rule ?? null,
    tier: result.system?.tier ?? null,
    dlp: result.system?.dlp ?? [],
    classification: result.system?.classification ?? null,
    signals: result.system?.signals ?? [],
    ip: input.ip ?? null,
    ...extra,
  });

  observeThreats(input, result.effect === "deny" && !(result as { retryAfterSec?: number }).retryAfterSec ? "blocked" : null);
}

/**
 * Feeds the threat detectors (key used from many addresses, rapid listing,
 * repeated exports, bulk deletes, repeated blocks) and acts on what they find.
 */
export function observeThreats(input: Pick<AuthorizeInput, "agent" | "ip" | "risk" | "action" | "request">, outcome: "blocked" | "escalation" | null): void {
  const signals = threatWindows.observe({
    agentId: input.agent._id.toString(),
    agentName: input.agent.name,
    ip: input.ip ?? null,
    risk: input.risk,
    isList: /:list$/.test(input.action),
    isBulk: Boolean(input.request && isBulkRead(input.request.method, input.request.path)),
    outcome,
  });
  if (signals.length) void handleThreats(input.agent, signals, input.action).catch(() => undefined);
}
