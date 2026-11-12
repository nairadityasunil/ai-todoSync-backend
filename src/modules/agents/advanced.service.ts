import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import EmailService from "../../shared/services/email.service.js";
import { AppError } from "../../utils/app-error.js";
import { decrypt, encrypt } from "../../utils/encryption.js";
import UserModel from "../auth/models/user.model.js";
import type { McpScope, RiskLevel } from "../mcp/registry/tool-types.js";
import ProjectModel from "../project/models/project.model.js";
import TaskModel from "../task/models/task.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { raiseAlert } from "./activity.service.js";
import {
  ANOMALY_RULES,
  BASELINE_WINDOW_DAYS,
  ChangeCounter,
  clampMinutes,
  computeBaseline,
  correlationClass,
  CorrelationWindows,
  effectiveClassification,
  elevationTier,
  rotationStep,
  scoreAnomaly,
  sessionRisk,
  strictestClassification,
  type AnomalyResult,
  type Classification,
  type SessionRisk,
} from "./advanced.js";
import {
  AgentBaselineModel,
  AgentElevationModel,
  type IAgentBaseline,
  type IAgentElevationDocument,
} from "./advanced.model.js";
import agentService, { ALL_AGENT_SCOPES } from "./agent.service.js";
import type { GovernanceSettings } from "./hybrid.js";
import {
  governanceSettings,
  logGovernanceEvent,
  openIncident,
  threatWindows,
} from "./hybrid.service.js";
import { AgentActivityModel, AgentModel, type IAgentDocument } from "./model.js";
import webhookService from "./webhooks.service.js";

const DAY = 86_400_000;

/* ------------------------------------------------------------------ */
/* Behaviour baselines and anomaly scoring                              */
/* ------------------------------------------------------------------ */

export const changeCounter = new ChangeCounter();
const baselineCache = new Map<string, { value: IAgentBaseline | null; at: number }>();
const BASELINE_TTL_MS = 5 * 60_000;

export async function baselineFor(agentId: string): Promise<IAgentBaseline | null> {
  const hit = baselineCache.get(agentId);
  if (hit && Date.now() - hit.at < BASELINE_TTL_MS) return hit.value;
  const value = await AgentBaselineModel.findOne({ agentId }).lean();
  if (baselineCache.size > 20_000) baselineCache.clear();
  baselineCache.set(agentId, { value: value as IAgentBaseline | null, at: Date.now() });
  return value as IAgentBaseline | null;
}

/** Recomputes one agent's baseline from its last 14 days of activity. */
export async function computeBaselineFor(agent: Pick<IAgentDocument, "_id" | "workspaceId">, now = new Date()): Promise<IAgentBaseline> {
  const rows = await AgentActivityModel.find({
    agentId: agent._id,
    createdAt: { $gte: new Date(now.getTime() - BASELINE_WINDOW_DAYS * DAY), $lte: now },
  })
    .select("createdAt action risk outcome projectId -_id")
    .sort({ createdAt: -1 })
    .limit(20_000)
    .lean();
  const stats = computeBaseline(
    rows.map((r) => ({ at: r.createdAt, action: r.action, risk: r.risk, outcome: r.outcome, projectId: r.projectId ? String(r.projectId) : null })),
    now,
  );
  const doc = await AgentBaselineModel.findOneAndUpdate(
    { agentId: agent._id },
    { $set: { ...stats, workspaceId: agent.workspaceId ?? null, computedAt: now } },
    { upsert: true, new: true },
  ).lean();
  baselineCache.delete(String(agent._id));
  return doc as unknown as IAgentBaseline;
}

/** Nightly: baselines for every agent active in the last two weeks. */
export async function recomputeAllBaselines(now = new Date()): Promise<number> {
  let count = 0;
  const cursor = AgentModel.find({ status: { $ne: "revoked" }, lastSeenAt: { $gte: new Date(now.getTime() - BASELINE_WINDOW_DAYS * DAY) } })
    .select("_id workspaceId")
    .cursor();
  for await (const agent of cursor) {
    try {
      await computeBaselineFor(agent, now);
      count += 1;
    } catch (error) {
      logger.warn("Baseline recompute failed", { agentId: String(agent._id), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return count;
}

const NO_ANOMALY: AnomalyResult = { score: 0, reasons: [], boost: null, volumeRatio: 0 };

/** Scores one call against the agent's baseline and alerts on large deviations. */
export async function assessAnomaly(
  agent: IAgentDocument,
  call: { action: string; risk: RiskLevel; projectId?: string | null },
  settings: GovernanceSettings,
): Promise<AnomalyResult> {
  if (!settings.anomalyDetection || call.risk === "read") return NO_ANOMALY;
  const agentId = agent._id.toString();
  const changesLastHour = changeCounter.add(agentId);
  const baseline = await baselineFor(agentId);
  const result = scoreAnomaly(baseline, { changesLastHour, action: call.action, projectId: call.projectId ?? null, risk: call.risk });
  if (result.score >= ANOMALY_RULES.highScore) {
    void raiseAlert({
      workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
      agentId,
      type: "anomaly",
      severity: result.score >= 80 ? "critical" : "warning",
      title: `${agent.name} is far from its usual behaviour`,
      detail: `${result.reasons.join(". ")}. Recommend review.`,
      dedupeKey: `anomaly:${agentId}:${Math.floor(Date.now() / 3600_000)}`,
    }).catch(() => undefined);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Session risk                                                         */
/* ------------------------------------------------------------------ */

const NORMAL_SESSION: SessionRisk = { score: 0, level: "normal", reasons: [], boost: null };
const passwordCache = new Map<string, { at: number; changedAt: Date | null }>();

async function passwordChangedAt(userId: string): Promise<Date | null> {
  const hit = passwordCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.changedAt;
  const user = await UserModel.findById(userId).select("passwordChangedAt").lean();
  const changedAt = (user as { passwordChangedAt?: Date | null } | null)?.passwordChangedAt ?? null;
  if (passwordCache.size > 20_000) passwordCache.clear();
  passwordCache.set(userId, { at: Date.now(), changedAt });
  return changedAt;
}

/** Header a trusted proxy (e.g. Cloudflare) sets with the caller's country. */
export const countryHeader = (): string => (process.env.GEO_COUNTRY_HEADER || "cf-ipcountry").toLowerCase();

/**
 * Network and credential signals for one call. An address seen for the first
 * time in the last 24 hours counts as new (when the agent has older ones), so
 * an attacker's address is not trusted after a single call.
 */
export async function assessSession(
  agent: IAgentDocument,
  ip: string | null | undefined,
  country: string | null | undefined,
  settings: GovernanceSettings,
): Promise<SessionRisk> {
  if (!settings.sessionRisk || !ip) return NORMAL_SESSION;
  const now = Date.now();
  const known = agent.knownIps ?? [];
  const established = known.filter((k) => now - new Date(k.firstSeen).getTime() > DAY);
  const entry = known.find((k) => k.ip === ip);
  const newIp = established.length > 0 && (!entry || now - new Date(entry.firstSeen).getTime() <= DAY);
  const countries = new Set(established.map((k) => k.country).filter(Boolean));
  const cc = country ? country.toUpperCase().slice(0, 4) : null;
  const newCountry = Boolean(cc) && countries.size > 0 && !countries.has(cc);
  const changed = await passwordChangedAt(String(agent.ownerUserId));
  const credentialChange = Boolean(changed && now - new Date(changed).getTime() < DAY);
  const concurrent = threatWindows.distinctIps(agent._id.toString()) >= 2;
  // Remember the address (at most 20, most recent first).
  if (!entry || now - new Date(entry.lastSeen).getTime() > 3600_000) {
    const next = [
      { ip, country: cc, firstSeen: entry?.firstSeen ?? new Date(now), lastSeen: new Date(now) },
      ...known.filter((k) => k.ip !== ip),
    ].slice(0, 20);
    agent.knownIps = next;
    void AgentModel.updateOne({ _id: agent._id }, { $set: { knownIps: next } }).catch(() => undefined);
  }
  const result = sessionRisk({ newIp, newCountry, credentialChange, concurrent });
  if (result.level === "high") {
    void raiseAlert({
      workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
      agentId: agent._id.toString(),
      type: "session_risk",
      severity: "warning",
      title: `${agent.name} is used in an unusual session`,
      detail: `${result.reasons.join(". ")}. Sensitive actions wait for a person.`,
      dedupeKey: `session_risk:${agent._id}:${ip}:${Math.floor(now / DAY)}`,
    }).catch(() => undefined);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Data classification                                                  */
/* ------------------------------------------------------------------ */

const labelCache = new Map<string, { at: number; label: string | null; projectId?: string | null }>();
const LABEL_TTL_MS = 30_000;

export const invalidateLabels = (id?: string): void => {
  if (id) labelCache.delete(id);
  else labelCache.clear();
};

async function projectLabel(projectId: string): Promise<string | null> {
  const hit = labelCache.get(`p:${projectId}`);
  if (hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.label;
  const project = Types.ObjectId.isValid(projectId) ? await ProjectModel.findById(projectId).select("classification").lean() : null;
  const label = (project as { classification?: string | null } | null)?.classification ?? null;
  if (labelCache.size > 50_000) labelCache.clear();
  labelCache.set(`p:${projectId}`, { at: Date.now(), label });
  return label;
}

async function taskLabel(taskId: string): Promise<{ label: string | null; projectId: string | null }> {
  const hit = labelCache.get(`t:${taskId}`);
  if (hit && Date.now() - hit.at < LABEL_TTL_MS) return { label: hit.label, projectId: hit.projectId ?? null };
  const task = Types.ObjectId.isValid(taskId) ? await TaskModel.findById(taskId).select("classification projectId").lean() : null;
  const value = {
    label: (task as { classification?: string | null } | null)?.classification ?? null,
    projectId: task?.projectId ? String(task.projectId) : null,
  };
  labelCache.set(`t:${taskId}`, { at: Date.now(), ...value });
  return value;
}

/** The strictest label among the projects (and the task) a call touches. */
export async function classificationFor(input: { projectIds: Array<string | null>; taskId?: string | null }): Promise<Classification> {
  const labels: Classification[] = [];
  for (const id of [...new Set(input.projectIds.filter((p): p is string => Boolean(p)))]) {
    labels.push(effectiveClassification(null, await projectLabel(id)));
  }
  if (input.taskId) {
    const task = await taskLabel(input.taskId);
    labels.push(effectiveClassification(task.label, task.projectId ? await projectLabel(task.projectId) : null));
  }
  return labels.length ? strictestClassification(labels) : "internal";
}

/* ------------------------------------------------------------------ */
/* Just-in-time access                                                  */
/* ------------------------------------------------------------------ */

const elevationCache = new Map<string, { at: number; scopes: string[]; ids: Map<string, string> }>();
const ELEVATION_TTL_MS = 10_000;

export const invalidateElevations = (agentId?: string): void => {
  if (agentId) elevationCache.delete(agentId);
  else elevationCache.clear();
};

async function grantedScopes(agentId: string): Promise<{ scopes: string[]; ids: Map<string, string> }> {
  const hit = elevationCache.get(agentId);
  if (hit && Date.now() - hit.at < ELEVATION_TTL_MS) return hit;
  const active = await AgentElevationModel.find({ agentId, status: "active", expiresAt: { $gt: new Date() } })
    .select("scopes expiresAt")
    .lean();
  const ids = new Map<string, string>();
  for (const e of active) for (const s of e.scopes) ids.set(s, String(e._id));
  const value = { at: Date.now(), scopes: [...ids.keys()], ids };
  if (elevationCache.size > 20_000) elevationCache.clear();
  elevationCache.set(agentId, value);
  return value;
}

/** The agent's standing scopes plus any just-in-time grant that has not ended. */
export async function effectiveScopes(agent: IAgentDocument): Promise<McpScope[]> {
  const { scopes } = await grantedScopes(agent._id.toString());
  return [...new Set([...agent.scopes, ...scopes])] as McpScope[];
}

/** A call used a just-in-time scope: count it on the grant. */
export async function noteElevationUse(agent: IAgentDocument, scope: string): Promise<void> {
  const { ids } = await grantedScopes(agent._id.toString());
  const id = ids.get(scope);
  if (id) await AgentElevationModel.updateOne({ _id: id }, { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => undefined);
}

const REQUEST_TTL_MS = 24 * 3600_000;

export const serializeElevation = (e: IAgentElevationDocument | Record<string, unknown>) => {
  const plain = (typeof (e as IAgentElevationDocument).toObject === "function" ? (e as IAgentElevationDocument).toObject() : e) as Record<string, unknown>;
  return { ...plain, id: String(plain._id) };
};

/** An agent asks for extra scopes for a while. Low-risk requests may be granted at once. */
export async function requestElevation(
  agent: IAgentDocument,
  body: { scopes?: unknown; reason?: unknown; durationMinutes?: unknown },
): Promise<IAgentElevationDocument> {
  const workspaceId = agent.workspaceId ? String(agent.workspaceId) : null;
  const settings = await governanceSettings(workspaceId);
  if (!settings.jitEnabled) throw new AppError(403, "Just-in-time access is turned off in this workspace.", "FORBIDDEN");
  if (agent.kind === "detected") throw new AppError(403, "Unregistered agents cannot request access. Use an agent key.", "FORBIDDEN");
  const requested = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
  const scopes = [...new Set(requested.filter((s) => (ALL_AGENT_SCOPES as string[]).includes(s) && !agent.scopes.includes(s as McpScope)))] as McpScope[];
  if (!scopes.length) throw new AppError(400, "Name at least one scope the agent does not already have.", "BAD_REQUEST");
  const tier = elevationTier(scopes, agent.riskLevel, agent.operatedBy === "vendor");
  if (tier === "forbidden") throw new AppError(403, "workspace:admin cannot be granted just in time. Ask an admin.", "FORBIDDEN");
  const reason = (typeof body.reason === "string" ? body.reason.trim() : "").slice(0, 500);
  if (!reason) throw new AppError(400, "Say why the agent needs this access (reason).", "BAD_REQUEST");
  const durationMinutes = clampMinutes(body.durationMinutes, settings.jitMaxMinutes);
  // One open request per agent and scope set at a time.
  const open = await AgentElevationModel.findOne({ agentId: agent._id, status: "pending", scopes: { $all: scopes, $size: scopes.length } });
  if (open) return open;
  const now = new Date();
  const auto = tier === "low" && settings.jitAutoGrantLowRisk;
  const elevation = await AgentElevationModel.create({
    workspaceId,
    agentId: agent._id,
    ownerUserId: agent.ownerUserId,
    scopes,
    reason,
    durationMinutes,
    tier,
    status: auto ? "active" : "pending",
    decidedBySystem: auto,
    decidedAt: auto ? now : null,
    grantedAt: auto ? now : null,
    expiresAt: new Date(now.getTime() + (auto ? durationMinutes * 60_000 : REQUEST_TTL_MS)),
  });
  invalidateElevations(agent._id.toString());
  await logGovernanceEvent({
    workspaceId,
    type: auto ? "elevation_granted" : "elevation_requested",
    actor: auto ? "system" : "person",
    agentId: agent._id.toString(),
    title: auto
      ? `System granted ${agent.name} ${scopes.join(", ")} for ${durationMinutes} min`
      : `${agent.name} asked for ${scopes.join(", ")} for ${durationMinutes} min`,
    detail: auto ? `Low-risk request, granted automatically. Reason: ${reason}` : `Reason: ${reason}. Waiting for a person.`,
  });
  if (!auto) {
    webhookService.emit({
      type: "access.requested",
      workspaceId,
      summary: `${agent.name} asks for ${scopes.join(", ")} for ${durationMinutes} minutes: ${reason}`,
      data: { elevationId: elevation._id.toString(), agentId: agent._id.toString(), agentName: agent.name, scopes, durationMinutes, tier, reason },
    });
  }
  return elevation;
}

/** Who may decide: a workspace admin, or the agent's owner unless an admin restricted it. */
export async function canDecideElevation(elevation: IAgentElevationDocument, userId: string, adminWorkspaceIds: Types.ObjectId[]): Promise<boolean> {
  const isAdmin = Boolean(elevation.workspaceId && adminWorkspaceIds.some((id) => id.equals(elevation.workspaceId as Types.ObjectId)));
  if (isAdmin) return true;
  if (String(elevation.ownerUserId) !== userId) return false;
  const agent = await AgentModel.findById(elevation.agentId).select("adminLocked operatedBy").lean();
  return Boolean(agent && !agent.adminLocked && agent.operatedBy !== "vendor");
}

export async function decideElevation(
  elevation: IAgentElevationDocument,
  userId: string,
  decision: "approve" | "reject",
  options: { minutes?: unknown; note?: string | null } = {},
): Promise<IAgentElevationDocument> {
  if (elevation.status !== "pending") throw new AppError(409, `This request is already ${elevation.status}.`, "CONFLICT");
  if (elevation.expiresAt.getTime() <= Date.now()) {
    elevation.status = "expired";
    elevation.endedAt = new Date();
    await elevation.save();
    throw new AppError(409, "This request lapsed. The agent can ask again.", "CONFLICT");
  }
  const agent = await AgentModel.findById(elevation.agentId);
  if (!agent || agent.status !== "active") throw new AppError(409, "The agent is not active.", "CONFLICT");
  const settings = await governanceSettings(elevation.workspaceId ? String(elevation.workspaceId) : null);
  const now = new Date();
  elevation.decidedBy = new Types.ObjectId(userId);
  elevation.decidedAt = now;
  elevation.note = options.note ?? null;
  if (decision === "approve") {
    const minutes = options.minutes !== undefined ? clampMinutes(options.minutes, settings.jitMaxMinutes) : Math.min(elevation.durationMinutes, settings.jitMaxMinutes);
    elevation.durationMinutes = minutes;
    elevation.status = "active";
    elevation.grantedAt = now;
    elevation.expiresAt = new Date(now.getTime() + minutes * 60_000);
  } else {
    elevation.status = "rejected";
    elevation.endedAt = now;
  }
  await elevation.save();
  invalidateElevations(String(elevation.agentId));
  await logGovernanceEvent({
    workspaceId: elevation.workspaceId ? String(elevation.workspaceId) : null,
    type: decision === "approve" ? "elevation_granted" : "elevation_rejected",
    actor: "person",
    userId,
    agentId: String(elevation.agentId),
    title: decision === "approve"
      ? `Granted ${agent.name} ${elevation.scopes.join(", ")} for ${elevation.durationMinutes} min`
      : `Refused ${agent.name} ${elevation.scopes.join(", ")}`,
    detail: elevation.reason,
  });
  return elevation;
}

export async function endElevation(elevation: IAgentElevationDocument, userId: string | null): Promise<IAgentElevationDocument> {
  if (elevation.status !== "active" && elevation.status !== "pending") throw new AppError(409, `This grant is already ${elevation.status}.`, "CONFLICT");
  elevation.status = "revoked";
  elevation.endedAt = new Date();
  await elevation.save();
  invalidateElevations(String(elevation.agentId));
  await logGovernanceEvent({
    workspaceId: elevation.workspaceId ? String(elevation.workspaceId) : null,
    type: "elevation_revoked",
    actor: userId ? "person" : "system",
    userId,
    agentId: String(elevation.agentId),
    title: `Ended ${elevation.scopes.join(", ")} early`,
    detail: elevation.reason,
  });
  return elevation;
}

/** Job: grants and requests whose time is up end, and each is logged. */
export async function expireElevations(now = new Date()): Promise<number> {
  const due = await AgentElevationModel.find({ status: { $in: ["active", "pending"] }, expiresAt: { $lte: now } }).limit(1000);
  for (const e of due) {
    const wasActive = e.status === "active";
    e.status = "expired";
    e.endedAt = now;
    await e.save();
    invalidateElevations(String(e.agentId));
    await logGovernanceEvent({
      workspaceId: e.workspaceId ? String(e.workspaceId) : null,
      type: wasActive ? "elevation_expired" : "elevation_lapsed",
      actor: "system",
      agentId: String(e.agentId),
      title: wasActive ? `System removed ${e.scopes.join(", ")}: the time-bound grant ended` : `Access request for ${e.scopes.join(", ")} lapsed`,
      detail: wasActive ? `Used ${e.usedCount} time(s).` : "No one decided within 24 hours.",
    });
  }
  return due.length;
}

/** Revoking an agent ends its grants and requests. */
export async function endElevationsFor(agentIds: Array<Types.ObjectId | string>): Promise<void> {
  if (!agentIds.length) return;
  await AgentElevationModel.updateMany(
    { agentId: { $in: agentIds }, status: { $in: ["pending", "active"] } },
    { $set: { status: "revoked", endedAt: new Date() } },
  );
  for (const id of agentIds) invalidateElevations(String(id));
}

/* ------------------------------------------------------------------ */
/* Cross-agent correlation                                              */
/* ------------------------------------------------------------------ */

export const correlationWindows = new CorrelationWindows();

/** Feeds the correlation window and opens one grouped incident for related agents. */
export async function observeCorrelation(input: {
  agent: IAgentDocument;
  action: string;
  risk: RiskLevel;
  projectId?: string | null;
  isBulk: boolean;
}): Promise<void> {
  const cls = correlationClass({ action: input.action, risk: input.risk, isBulk: input.isBulk });
  const workspaceId = input.agent.workspaceId ? String(input.agent.workspaceId) : null;
  if (!cls || !workspaceId) return;
  const settings = await governanceSettings(workspaceId);
  if (!settings.correlation) return;
  const signals = correlationWindows.observe({
    workspaceId,
    agentId: input.agent._id.toString(),
    agentName: input.agent.name,
    cls,
    projectId: input.projectId ?? null,
  });
  if (!signals.length) return;
  const { recomputeRisk } = await import("./governance.service.js");
  for (const signal of signals) {
    const agents = await AgentModel.find({ _id: { $in: signal.agentIds } });
    await openIncident({
      workspaceId,
      agents,
      trigger: signal.type,
      severity: signal.severity,
      title: signal.title,
      summary: signal.detail,
      action: input.action,
      // Grouped for a person to review; containment is left to playbooks.
      contain: false,
    });
    const bucket = Math.floor(Date.now() / 600_000);
    for (const agent of agents) {
      await raiseAlert({
        workspaceId,
        agentId: agent._id.toString(),
        type: "coordinated_access",
        severity: signal.severity,
        title: signal.title,
        detail: signal.detail,
        dedupeKey: `coordinated:${signal.type}:${agent._id}:${bucket}`,
      }).catch(() => undefined);
      await recomputeRisk(agent).catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Key lifecycle                                                        */
/* ------------------------------------------------------------------ */

const emailOwner = async (ownerUserId: unknown, subject: string, text: string): Promise<void> => {
  try {
    const owner = await UserModel.findById(ownerUserId).select("email").lean();
    if (owner?.email) await EmailService.sendEmail(owner.email, subject, text);
  } catch (error) {
    logger.warn("Could not email key owner", { message: error instanceof Error ? error.message : String(error) });
  }
};

const portalUrl = (): string => (process.env.FRONTEND_URL || process.env.APP_URL || "").replace(/\/$/, "");

/**
 * Rotates a key with an overlap: the old key keeps working for `graceHours`.
 * A system rotation keeps the new key encrypted until the owner reveals it once.
 */
export async function rotateWithGrace(agent: IAgentDocument, graceHours: number, by: { userId: string } | { system: true }): Promise<string> {
  const key = await agentService.rotateKey(agent, graceHours);
  const system = "system" in by;
  if (system) {
    agent.pendingKeyCiphertext = encrypt(key);
    agent.pendingKeyIssuedAt = new Date();
    await AgentModel.updateOne({ _id: agent._id }, { $set: { pendingKeyCiphertext: agent.pendingKeyCiphertext, pendingKeyIssuedAt: agent.pendingKeyIssuedAt } });
  }
  await logGovernanceEvent({
    workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
    type: "key_rotated",
    actor: system ? "system" : "person",
    userId: system ? null : by.userId,
    agentId: agent._id.toString(),
    title: `${system ? "System rotated" : "Rotated"} the key for ${agent.name}`,
    detail: graceHours > 0 ? `The old key keeps working for ${graceHours} hours, then stops.` : "The old key stopped working at once.",
  });
  return key;
}

/** The owner collects a key the system rotated; it is shown once. */
export async function revealPendingKey(agent: IAgentDocument): Promise<string> {
  if (!agent.pendingKeyCiphertext) throw new AppError(404, "There is no new key waiting for this agent.", "NOT_FOUND");
  const key = decrypt(agent.pendingKeyCiphertext);
  agent.pendingKeyCiphertext = null;
  agent.pendingKeyIssuedAt = null;
  await AgentModel.updateOne({ _id: agent._id }, { $set: { pendingKeyCiphertext: null, pendingKeyIssuedAt: null } });
  return key;
}

/**
 * Warns owners of keys near their maximum age, rotates low-risk keys a day
 * before they are due (automatic mode) and retires old keys whose grace
 * period ended.
 */
export async function runKeyLifecycle(options: { workspaceId?: string; now?: Date } = {}): Promise<{ notified: number; rotated: number; confirm: number; retired: number }> {
  const now = options.now ?? new Date();
  const counts = { notified: 0, rotated: 0, confirm: 0, retired: 0 };
  const scope = options.workspaceId ? { workspaceId: new Types.ObjectId(options.workspaceId) } : {};

  const retiring = await AgentModel.find({ ...scope, previousKeyHash: { $type: "string" }, previousKeyExpiresAt: { $lte: now } }).select("name workspaceId");
  for (const agent of retiring) {
    await AgentModel.updateOne({ _id: agent._id }, { $set: { previousKeyHash: null, previousKeyExpiresAt: null } });
    agentService.invalidate(agent._id.toString());
    counts.retired += 1;
    await logGovernanceEvent({
      workspaceId: agent.workspaceId ? String(agent.workspaceId) : null,
      type: "key_retired",
      actor: "system",
      agentId: agent._id.toString(),
      title: `System revoked the old key of ${agent.name}`,
      detail: "The grace period after rotation ended.",
    });
  }

  const workspaces = options.workspaceId
    ? [{ _id: new Types.ObjectId(options.workspaceId) }]
    : await WorkspaceModel.find({}).select("_id").lean();
  for (const ws of workspaces) {
    const workspaceId = String(ws._id);
    const settings = await governanceSettings(workspaceId);
    if (settings.keyRotation === "off" || settings.keyMaxAgeDays <= 0) continue;
    const agents = await AgentModel.find({ workspaceId: ws._id, kind: "api_key", status: "active", keyHash: { $type: "string" } });
    for (const agent of agents) {
      const issuedAt = agent.keyIssuedAt ?? agent.createdAt;
      if (!issuedAt) continue;
      const alreadyNotified = Boolean(agent.rotationNotifiedAt && agent.rotationNotifiedAt.getTime() >= new Date(issuedAt).getTime());
      const step = rotationStep({
        issuedAt: new Date(issuedAt),
        maxAgeDays: settings.keyMaxAgeDays,
        mode: settings.keyRotation,
        riskLevel: agent.riskLevel,
        alreadyNotified,
        isVendor: agent.operatedBy === "vendor",
        now,
      });
      if (step === "none") continue;
      const ageDays = Math.floor((now.getTime() - new Date(issuedAt).getTime()) / DAY);
      const link = portalUrl() ? `${portalUrl()}/agents?agent=${agent._id}` : "Agent Governance in Pristine";
      if (step === "rotate") {
        await rotateWithGrace(agent, settings.keyGraceHours, { system: true });
        counts.rotated += 1;
        await raiseAlert({
          workspaceId,
          agentId: agent._id.toString(),
          type: "key_rotation_due",
          severity: "info",
          title: `${agent.name}'s key was rotated`,
          detail: `It was ${ageDays} days old (limit ${settings.keyMaxAgeDays}). The old key works for ${settings.keyGraceHours} more hours. The owner can collect the new key once.`,
          dedupeKey: `key_rotated:${agent._id}:${Math.floor(now.getTime() / DAY)}`,
        }).catch(() => undefined);
        await emailOwner(
          agent.ownerUserId,
          `New key for ${agent.name}`,
          `Pristine rotated the key for "${agent.name}" because it was ${ageDays} days old (your workspace allows ${settings.keyMaxAgeDays}).\n\nThe old key keeps working for ${settings.keyGraceHours} hours. Collect the new key (shown once) in ${link}, then update the agent.`,
        );
        continue;
      }
      await AgentModel.updateOne({ _id: agent._id }, { $set: { rotationNotifiedAt: now } });
      if (step === "confirm") counts.confirm += 1;
      else counts.notified += 1;
      const detail =
        step === "confirm"
          ? `It is ${ageDays} days old (limit ${settings.keyMaxAgeDays}). It is ${agent.operatedBy === "vendor" ? "used by a third party" : `${agent.riskLevel} risk`}, so a person must confirm the rotation.`
          : `It is ${ageDays} days old (limit ${settings.keyMaxAgeDays}). Rotate it before it expires.`;
      await raiseAlert({
        workspaceId,
        agentId: agent._id.toString(),
        type: "key_rotation_due",
        severity: "warning",
        title: step === "confirm" ? `Confirm the key rotation for ${agent.name}` : `${agent.name}'s key is due for rotation`,
        detail,
        dedupeKey: `key_rotation_due:${agent._id}:${new Date(issuedAt).getTime()}`,
      }).catch(() => undefined);
      await emailOwner(agent.ownerUserId, `Key for ${agent.name} is due for rotation`, `${detail}\n\nRotate it in ${link}. The old key can keep working for a grace period so nothing breaks.`);
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Admin helpers                                                        */
/* ------------------------------------------------------------------ */

export async function workspaceAdminEmails(workspaceId: string): Promise<string[]> {
  const admins = await WorkspaceMemberModel.find({ workspaceId, role: { $in: ["OWNER", "ADMIN"] } }).select("userId").lean();
  const users = await UserModel.find({ _id: { $in: admins.map((a) => a.userId) } }).select("email").lean();
  return users.map((u) => u.email).filter(Boolean);
}
