import { randomUUID } from "node:crypto";

import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import { AppError } from "../../utils/app-error.js";
import { raiseAlert } from "../agents/activity.service.js";
import { AgentModel } from "../agents/model.js";
import { maskText } from "../agents/redaction.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";
import UserModel from "../auth/models/user.model.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import PromptLibraryModel from "../prompt/models/prompt-library.model.js";
import { closeTask, openTask } from "../telemetry/automation.service.js";
import { AutomationLinkModel } from "../telemetry/model.js";
import { VendorModel } from "../vendors/model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import {
  AI_TYPES,
  APPROVER_ROLES,
  classifyEuAiAct,
  CONTROLS,
  DEFAULT_REVIEW_DAYS,
  GATES,
  METRIC_KEYS,
  METRICS,
  missingEuAnswers,
  missingRiskAnswers,
  requiredApprovals,
  RISK_CATEGORY_LABELS,
  RISK_LIBRARY,
  riskTier,
  ROLE_LABELS,
  sanitizeEuAnswers,
  sanitizeRiskAnswers,
  STAGE_LABELS,
  STAGES,
  suggestRisks,
  type AiType,
  type ApproverRole,
  type Gate,
  type MetricKey,
  type Tier,
} from "./catalog.js";
import {
  addRecord,
  addTotals,
  emptyTotals,
  evaluateTotals,
  overallStatus,
  scoreRecord,
  topTerms,
  type MetricResult,
  type Totals,
} from "./evaluators.js";
import {
  currentRiskLevel,
  governanceScore,
  heatmap,
  nextStage,
  pendingRoles,
  requirementsFor,
  type Snapshot,
} from "./lifecycle.js";
import {
  AiGovernanceSettingsModel,
  AiIssueModel,
  AiMetricBucketModel,
  AiRecordModel,
  AiUseCaseModel,
  FACTSHEET_FIELDS,
  ISSUE_STATUSES,
  SEVERITIES,
  type Factsheet,
  type HistoryEntry,
  type IAiGovernanceSettingsDocument,
  type IAiIssueDocument,
  type IAiUseCaseDocument,
  type IssueStatus,
  type Severity,
  type UseCaseRisk,
} from "./model.js";

const DAY = 86400000;
const str = (value: unknown, max = 500): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const bad = (message: string): AppError =>
  new AppError(400, message, "BAD_REQUEST");
const notFound = (what: string): AppError =>
  new AppError(404, `${what} not found`, "NOT_FOUND");
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const oid = (value: string) => new Types.ObjectId(value);

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

export interface Actor {
  userId: string;
  name: string;
  workspaceId: string;
  isAdmin: boolean;
}

/** The workspace the request is about (?workspaceId, else the person's first) and their rights in it. */
export async function actorFor(
  userId: string,
  requestedWorkspaceId?: string,
): Promise<Actor> {
  const memberships = await WorkspaceMemberModel.find({ userId })
    .select("workspaceId role createdAt")
    .lean();
  if (!memberships.length)
    throw new AppError(403, "You are not in a workspace", "FORBIDDEN");
  const sorted = [...memberships].sort(
    (a, b) =>
      new Date(a.createdAt as Date).getTime() -
      new Date(b.createdAt as Date).getTime(),
  );
  const membership = requestedWorkspaceId
    ? sorted.find((m) => String(m.workspaceId) === requestedWorkspaceId)
    : (sorted.find((m) => m.role === "OWNER" || m.role === "ADMIN") ??
      sorted[0]);
  if (!membership)
    throw new AppError(
      403,
      "You are not a member of that workspace",
      "FORBIDDEN",
    );
  if (membership.role === "GUEST")
    throw new AppError(403, "Guests cannot use AI governance", "FORBIDDEN");
  const user = await UserModel.findById(userId).select("name email").lean();
  return {
    userId,
    name: user?.name || user?.email || "Someone",
    workspaceId: String(membership.workspaceId),
    isAdmin: membership.role === "OWNER" || membership.role === "ADMIN",
  };
}

const requireAdmin = (actor: Actor): void => {
  if (!actor.isAdmin)
    throw new AppError(
      403,
      "Only workspace owners and admins can do this",
      "FORBIDDEN",
    );
};

export async function settingsFor(
  workspaceId: string,
): Promise<IAiGovernanceSettingsDocument> {
  const found = await AiGovernanceSettingsModel.findOne({ workspaceId });
  if (found) return found;
  try {
    return await AiGovernanceSettingsModel.create({ workspaceId, nextRef: 0 });
  } catch {
    // Two first requests at once: the other one created it.
    const again = await AiGovernanceSettingsModel.findOne({ workspaceId });
    if (!again)
      throw new AppError(
        500,
        "Could not load AI governance settings",
        "INTERNAL",
      );
    return again;
  }
}

async function nextRef(workspaceId: string): Promise<string> {
  await settingsFor(workspaceId);
  const updated = await AiGovernanceSettingsModel.findOneAndUpdate(
    { workspaceId },
    { $inc: { nextRef: 1 } },
    { new: true },
  );
  return `UC-${updated?.nextRef ?? Date.now()}`;
}

export async function members(
  workspaceId: string,
): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const rows = await WorkspaceMemberModel.find({
    workspaceId,
    role: { $ne: "GUEST" },
  })
    .select("userId role")
    .lean();
  const users = await UserModel.find({
    _id: { $in: rows.map((r) => r.userId) },
  })
    .select("name email")
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => {
    const u = byId.get(String(r.userId));
    return {
      id: String(r.userId),
      name: u?.name || u?.email || "Unknown",
      email: u?.email ?? "",
      role: r.role,
    };
  });
}

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number })?.code === 11000;
const isVersionError = (error: unknown): boolean =>
  (error as { name?: string })?.name === "VersionError";

/** The overview is read far more often than it changes: keep it for a few seconds per workspace. */
const OVERVIEW_TTL_MS = 5000;
const overviewCache = new Map<string, { at: number; data: unknown }>();

/**
 * Loads a use case, applies a change and saves it. If someone else saved it in
 * between, loads it again and re-applies. For changes the system makes itself
 * (evaluations), where "reload and try again" is not something to ask a person.
 */
async function mutate<T>(
  id: unknown,
  apply: (uc: IAiUseCaseDocument) => Promise<T>,
): Promise<{ uc: IAiUseCaseDocument; result: T } | null> {
  for (let attempt = 0; ; attempt++) {
    const uc = await AiUseCaseModel.findById(id);
    if (!uc) return null;
    const result = await apply(uc);
    try {
      overviewCache.delete(String(uc.workspaceId));
      await uc.save();
      return { uc, result };
    } catch (error) {
      if (!isVersionError(error)) throw error;
      if (attempt >= 8)
        throw new AppError(
          409,
          "This use case is being changed by several people at once. Try again in a moment.",
          "CONFLICT",
        );
      await new Promise((resolve) =>
        setTimeout(resolve, 20 * (attempt + 1) + Math.random() * 60),
      );
    }
  }
}

/** Saves a use case; if someone else saved it in the meantime, says so instead of overwriting their change. */
async function persist(uc: IAiUseCaseDocument): Promise<void> {
  overviewCache.delete(String(uc.workspaceId));
  try {
    await uc.save();
  } catch (error) {
    if ((error as { name?: string })?.name === "VersionError")
      throw new AppError(
        409,
        "Someone else changed this use case at the same time. Reload it and try again.",
        "CONFLICT",
      );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const history = (
  uc: { history: HistoryEntry[]; markModified?: (path: string) => void },
  actor: Pick<Actor, "userId" | "name"> | null,
  action: string,
  detail = "",
): void => {
  const list = Array.isArray(uc.history) ? uc.history : [];
  list.push({
    at: new Date(),
    by: actor?.userId ?? null,
    byName: actor?.name ?? "Pristine",
    action,
    detail: detail.slice(0, 500),
  });
  uc.history = list.slice(-300);
  uc.markModified?.("history");
};

const openIssuesOf = async (useCaseId: Types.ObjectId | string) =>
  AiIssueModel.find({ useCaseId, status: { $in: ["open", "in_progress"] } })
    .select("severity title status source")
    .lean();

function snapshot(
  uc: IAiUseCaseDocument,
  openIssues: Array<{ severity: string }>,
  settings: IAiGovernanceSettingsDocument | null,
): Snapshot {
  return {
    stage: uc.stage,
    status: uc.status,
    tier: uc.assessment?.tier ?? null,
    assessed: Boolean(uc.assessment),
    factsheet: uc.factsheet ?? {},
    links: {
      agentIds: uc.links?.agentIds ?? [],
      promptIds: uc.links?.promptIds ?? [],
      vendorIds: uc.links?.vendorIds ?? [],
    },
    risks: uc.risks ?? [],
    approvals: uc.approvals ?? [],
    evaluation: uc.evaluation,
    openIssues,
    nextReviewAt: uc.nextReviewAt,
    highRiskExtraRoles: (settings?.highRiskExtraRoles ?? []) as ApproverRole[],
  };
}

/** Recomputes the stored score. Call before saving after anything that can change it. */
async function rescore(
  uc: IAiUseCaseDocument,
  settings?: IAiGovernanceSettingsDocument | null,
): Promise<Snapshot> {
  const s = snapshot(
    uc,
    await openIssuesOf(uc._id),
    settings ?? (await settingsFor(String(uc.workspaceId))),
  );
  uc.score = governanceScore(s).score;
  return s;
}

const summary = (
  uc: IAiUseCaseDocument | (Record<string, unknown> & { _id: unknown }),
) => {
  const u = uc as unknown as IAiUseCaseDocument;
  return {
    id: String(u._id),
    ref: u.ref,
    name: u.name,
    description: u.description,
    type: u.type,
    stage: u.stage,
    status: u.status,
    tier: u.assessment?.tier ?? null,
    euCategory: u.assessment?.eu?.category ?? null,
    ownerUserId: String(u.ownerUserId),
    score: u.score ?? 0,
    evaluationStatus: u.evaluation?.status ?? null,
    evaluatedAt: u.evaluation?.ranAt ?? null,
    nextReviewAt: u.nextReviewAt,
    risks: (u.risks ?? []).length,
    updatedAt: u.updatedAt,
  };
};

async function detail(uc: IAiUseCaseDocument, actor: Actor) {
  const [settings, issues] = await Promise.all([
    settingsFor(String(uc.workspaceId)),
    openIssuesOf(uc._id),
  ]);
  const s = snapshot(uc, issues, settings);
  const { score, parts } = governanceScore(s);
  const tier = uc.assessment?.tier ?? null;
  const gates = GATES.map((gate) => ({
    gate,
    required: requiredApprovals(gate, tier, s.highRiskExtraRoles).map(
      (role) => ({
        role,
        label: ROLE_LABELS[role],
        signoff:
          [...(uc.approvals ?? [])]
            .reverse()
            .find((a) => a.gate === gate && a.role === role && !a.void) ?? null,
        canSign: canSign(actor, uc, role, settings),
      }),
    ),
    pending: pendingRoles(s, gate),
  }));
  return {
    ...summary(uc),
    businessValue: uc.businessValue,
    createdBy: String(uc.createdBy),
    riskAnswers: uc.riskAnswers ?? {},
    euAnswers: uc.euAnswers ?? {},
    assessment: uc.assessment,
    factsheet: uc.factsheet ?? {},
    links: uc.links,
    riskList: (uc.risks ?? []).map((r) => ({
      ...r,
      level: currentRiskLevel(r),
    })),
    approvals: uc.approvals ?? [],
    gates,
    thresholds: uc.thresholds ?? {},
    evaluation: uc.evaluation,
    baseline: uc.baseline
      ? { at: uc.baseline.at, records: uc.baseline.records }
      : null,
    reviewDays:
      uc.reviewDays ??
      (tier && tier !== "prohibited" ? DEFAULT_REVIEW_DAYS[tier] : null),
    lastAttestedAt: uc.lastAttestedAt,
    lastAttestedBy: uc.lastAttestedBy,
    score,
    scoreParts: parts,
    nextStage: nextStage(uc.stage),
    requirements: requirementsFor(s),
    openIssues: issues.map((i) => ({
      id: String(i._id),
      title: i.title,
      severity: i.severity,
      status: i.status,
      source: i.source,
    })),
    history: [...(uc.history ?? [])].reverse().slice(0, 100),
    canEdit: canEdit(actor, uc),
    canAdmin: actor.isAdmin,
  };
}

const canEdit = (actor: Actor, uc: IAiUseCaseDocument): boolean =>
  actor.isAdmin ||
  String(uc.ownerUserId) === actor.userId ||
  (String(uc.createdBy) === actor.userId &&
    (uc.stage === "proposed" || uc.stage === "assessment"));

function canSign(
  actor: Actor,
  uc: IAiUseCaseDocument,
  role: ApproverRole,
  settings: IAiGovernanceSettingsDocument,
): boolean {
  if (role === "owner")
    return String(uc.ownerUserId) === actor.userId || actor.isAdmin;
  const assigned =
    (settings.approvers as Record<string, string[]> | undefined)?.[role] ?? [];
  return assigned.length ? assigned.includes(actor.userId) : actor.isAdmin;
}

async function load(actor: Actor, id: string): Promise<IAiUseCaseDocument> {
  if (!isId(id)) throw notFound("Use case");
  const uc = await AiUseCaseModel.findOne({
    _id: id,
    workspaceId: actor.workspaceId,
  });
  if (!uc) throw notFound("Use case");
  return uc;
}

const requireEdit = (actor: Actor, uc: IAiUseCaseDocument): void => {
  if (!canEdit(actor, uc))
    throw new AppError(
      403,
      "Only the owner of this use case or a workspace admin can change it",
      "FORBIDDEN",
    );
  if (uc.stage === "retired") throw bad("A retired use case cannot be changed");
};

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export async function listUseCases(
  actor: Actor,
  filter: { stage?: string; tier?: string; q?: string },
) {
  const query: Record<string, unknown> = { workspaceId: actor.workspaceId };
  if (filter.stage && (STAGES as readonly string[]).includes(filter.stage))
    query.stage = filter.stage;
  const rows = await AiUseCaseModel.find(query)
    .select(
      "-history -riskAnswers -euAnswers -baseline -factsheet -approvals -links -thresholds -businessValue",
    )
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean();
  let list = rows.map((r) => summary(r as never));
  if (filter.tier) list = list.filter((u) => u.tier === filter.tier);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    list = list.filter(
      (u) =>
        u.name.toLowerCase().includes(q) || u.ref.toLowerCase().includes(q),
    );
  }
  return list;
}

export async function createUseCase(
  actor: Actor,
  body: Record<string, unknown>,
) {
  const name = str(body.name, 120);
  if (name.length < 3)
    throw bad("Give the use case a name of at least 3 characters");
  const type = (AI_TYPES as readonly string[]).includes(String(body.type))
    ? (body.type as AiType)
    : "generative";
  const ownerUserId = isId(body.ownerUserId) ? body.ownerUserId : actor.userId;
  if (ownerUserId !== actor.userId) {
    const member = await WorkspaceMemberModel.findOne({
      workspaceId: actor.workspaceId,
      userId: ownerUserId,
      role: { $ne: "GUEST" },
    }).lean();
    if (!member) throw bad("The owner must be a member of this workspace");
  }
  const links = await sanitizeLinks(actor.workspaceId, body.links);
  const uc = new AiUseCaseModel({
    workspaceId: actor.workspaceId,
    ref: "pending",
    name,
    description: str(body.description, 2000),
    businessValue: str(body.businessValue, 1000),
    type,
    ownerUserId,
    createdBy: actor.userId,
    factsheet: sanitizeFactsheet(body.factsheet, {}),
    links,
    history: [],
  });
  history(uc, actor, "created", `Proposed "${name}"`);
  await rescore(uc);
  // References are unique per workspace. If two people register at the same moment and draw the same number, take the next one.
  for (let attempt = 0; ; attempt++) {
    uc.ref = await nextRef(actor.workspaceId);
    try {
      await persist(uc);
      break;
    } catch (error) {
      if (!isDuplicateKey(error) || attempt >= 25) throw error;
      uc.isNew = true;
    }
  }
  return detail(uc, actor);
}

function sanitizeFactsheet(
  raw: unknown,
  current: Partial<Factsheet>,
): Factsheet {
  const out = { ...current } as Record<string, string>;
  if (raw && typeof raw === "object") {
    for (const f of FACTSHEET_FIELDS) {
      const value = (raw as Record<string, unknown>)[f.key];
      if (typeof value === "string") out[f.key] = value.trim().slice(0, 2000);
    }
  }
  for (const f of FACTSHEET_FIELDS) out[f.key] = out[f.key] ?? "";
  return out as unknown as Factsheet;
}

/** Keeps only assets that exist in this workspace. */
async function sanitizeLinks(
  workspaceId: string,
  raw: unknown,
  current?: IAiUseCaseDocument["links"],
) {
  const base = {
    agentIds: current?.agentIds ?? [],
    promptIds: current?.promptIds ?? [],
    vendorIds: current?.vendorIds ?? [],
    projectId: current?.projectId ?? null,
    integrationIds: current?.integrationIds ?? [],
  };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const ids = (value: unknown): string[] | null =>
    Array.isArray(value)
      ? Array.from(new Set(value.filter(isId))).slice(0, 50)
      : null;
  const [agentIds, promptIds, vendorIds] = [
    ids(r.agentIds),
    ids(r.promptIds),
    ids(r.vendorIds),
  ];
  if (agentIds)
    base.agentIds = (
      await AgentModel.find({ _id: { $in: agentIds }, workspaceId })
        .select("_id")
        .lean()
    ).map((a) => String(a._id));
  if (promptIds)
    base.promptIds = (
      await PromptLibraryModel.find({ _id: { $in: promptIds }, workspaceId })
        .select("_id")
        .lean()
    ).map((p) => String(p._id));
  if (vendorIds)
    base.vendorIds = (
      await VendorModel.find({ _id: { $in: vendorIds }, workspaceId })
        .select("_id")
        .lean()
    ).map((v) => String(v._id));
  const integrationIds = ids(r.integrationIds);
  if (integrationIds) {
    // Only apps owned by people in this workspace can be allowed to send interactions.
    const memberIds = (await members(workspaceId)).map((m) => m.id);
    base.integrationIds = (
      await SdkIntegrationModel.find({
        _id: { $in: integrationIds },
        tenantId: { $in: memberIds },
      })
        .select("_id")
        .lean()
    ).map((i) => String(i._id));
  }
  return base;
}

export async function getUseCase(actor: Actor, id: string) {
  return detail(await load(actor, id), actor);
}

export async function updateUseCase(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  requireEdit(actor, uc);
  const changed: string[] = [];
  if (body.name !== undefined) {
    const name = str(body.name, 120);
    if (name.length < 3)
      throw bad("Give the use case a name of at least 3 characters");
    if (name !== uc.name) changed.push("name");
    uc.name = name;
  }
  if (body.description !== undefined)
    uc.description = str(body.description, 2000);
  if (body.businessValue !== undefined)
    uc.businessValue = str(body.businessValue, 1000);
  if (body.type !== undefined) {
    if (!(AI_TYPES as readonly string[]).includes(String(body.type)))
      throw bad("Unknown AI type");
    uc.type = body.type as AiType;
  }
  if (body.ownerUserId !== undefined) {
    requireAdmin(actor);
    if (!isId(body.ownerUserId)) throw bad("Choose an owner");
    const member = await WorkspaceMemberModel.findOne({
      workspaceId: actor.workspaceId,
      userId: body.ownerUserId,
      role: { $ne: "GUEST" },
    }).lean();
    if (!member) throw bad("The owner must be a member of this workspace");
    uc.ownerUserId = oid(body.ownerUserId);
    changed.push("owner");
  }
  if (body.factsheet !== undefined) {
    uc.factsheet = sanitizeFactsheet(body.factsheet, uc.factsheet ?? {});
    uc.markModified("factsheet");
    changed.push("factsheet");
  }
  if (body.links !== undefined) {
    uc.links = await sanitizeLinks(actor.workspaceId, body.links, uc.links);
    uc.markModified("links");
    changed.push("linked assets");
  }
  if (body.thresholds !== undefined) {
    requireAdmin(actor);
    const next: Partial<Record<MetricKey, number>> = {};
    if (body.thresholds && typeof body.thresholds === "object") {
      for (const m of METRICS) {
        const value = (body.thresholds as Record<string, unknown>)[m.key];
        if (value === null || value === undefined || value === "") continue;
        const n = Number(value);
        const max = m.unit === "ms" ? 600000 : 1;
        if (!Number.isFinite(n) || n < 0 || n > max)
          throw bad(`${m.label}: the threshold must be between 0 and ${max}`);
        next[m.key] = n;
      }
    }
    uc.thresholds = next;
    uc.markModified("thresholds");
    changed.push("evaluation thresholds");
  }
  if (body.reviewDays !== undefined) {
    requireAdmin(actor);
    const n = Number(body.reviewDays);
    if (!Number.isInteger(n) || n < 7 || n > 730)
      throw bad("Review every 7 to 730 days");
    uc.reviewDays = n;
    if (uc.lastAttestedAt)
      uc.nextReviewAt = new Date(uc.lastAttestedAt.getTime() + n * DAY);
    changed.push("review cadence");
  }
  if (changed.length)
    history(uc, actor, "updated", `Changed ${changed.join(", ")}`);
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

export async function deleteUseCase(actor: Actor, id: string) {
  requireAdmin(actor);
  const uc = await load(actor, id);
  if (uc.stage === "production")
    throw bad(
      "Retire a production use case instead of deleting it, so its record is kept",
    );
  const issues = await AiIssueModel.find({ useCaseId: uc._id })
    .select("_id")
    .lean();
  for (const issue of issues)
    await closeIssueTask(String(issue._id), "the use case was deleted.");
  overviewCache.delete(actor.workspaceId);
  await Promise.all([
    AiIssueModel.deleteMany({ useCaseId: uc._id }),
    AiRecordModel.deleteMany({ useCaseId: uc._id }),
    AiMetricBucketModel.deleteMany({ useCaseId: uc._id }),
    uc.deleteOne(),
  ]);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export async function saveAssessment(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  requireEdit(actor, uc);
  const riskAnswers = sanitizeRiskAnswers(body.riskAnswers);
  const euAnswers = sanitizeEuAnswers(body.euAnswers);
  uc.riskAnswers = riskAnswers;
  uc.euAnswers = euAnswers;
  uc.markModified("riskAnswers");
  uc.markModified("euAnswers");
  const complete = body.complete === true;
  if (complete) {
    const missing = [
      ...missingRiskAnswers(riskAnswers),
      ...missingEuAnswers(euAnswers),
    ];
    if (missing.length)
      throw bad(`Answer every question first (${missing.length} left)`);
    const eu = classifyEuAiAct(euAnswers);
    const tier = riskTier(riskAnswers, eu.category);
    const previous = uc.assessment?.tier ?? null;
    uc.assessment = {
      tier: tier.tier,
      points: tier.points,
      reasons: tier.reasons,
      eu,
      completedAt: new Date(),
      by: actor.name,
    };
    uc.markModified("assessment");
    history(
      uc,
      actor,
      "assessed",
      `Risk tier ${tier.tier}; EU AI Act: ${eu.category.replace(/_/g, " ")}`,
    );
    if (
      previous &&
      previous !== tier.tier &&
      (uc.approvals ?? []).some((a) => !a.void)
    ) {
      // A different tier needs different sign-offs: earlier approvals no longer stand (kept, marked superseded).
      uc.approvals = uc.approvals.map((a) => ({ ...a, void: true }));
      uc.markModified("approvals");
      history(
        uc,
        null,
        "approvals_cleared",
        `The risk tier changed from ${previous} to ${tier.tier}, so earlier approvals no longer count`,
      );
    }
    if (tier.tier === "prohibited") {
      uc.status = "rejected";
      history(uc, null, "rejected", "Prohibited under the EU AI Act (Art. 5)");
      await raiseAlert({
        workspaceId: actor.workspaceId,
        type: "ai_use_case_prohibited",
        severity: "critical",
        title: `Prohibited AI use case: ${uc.name}`,
        detail: eu.reasons.join(" ").slice(0, 400),
        dedupeKey: `ai_use_case_prohibited:${uc._id}`,
      }).catch(() => undefined);
    } else if (uc.status === "rejected" && previous === "prohibited") {
      uc.status = "active";
    }
  }
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

const scale = (value: unknown, field: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5)
    throw bad(`${field} must be 1 to 5`);
  return n;
};

export async function suggestedRisks(actor: Actor, id: string) {
  const uc = await load(actor, id);
  const have = new Set((uc.risks ?? []).map((r) => r.code));
  return suggestRisks({ type: uc.type, riskAnswers: uc.riskAnswers ?? {} }).map(
    (r) => ({
      code: r.code,
      category: r.category,
      categoryLabel: RISK_CATEGORY_LABELS[r.category],
      title: r.title,
      description: r.description,
      controls: r.controls,
      added: have.has(r.code),
    }),
  );
}

export async function addRisks(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  requireEdit(actor, uc);
  const added: string[] = [];
  const codes = Array.isArray(body.codes)
    ? body.codes.filter((c): c is string => typeof c === "string")
    : [];
  for (const code of codes) {
    const lib = RISK_LIBRARY.find((r) => r.code === code);
    if (!lib || uc.risks.some((r) => r.code === code)) continue;
    uc.risks.push({
      id: randomUUID(),
      code,
      category: lib.category,
      title: lib.title,
      description: lib.description,
      likelihood: 3,
      impact: 3,
      treatment: null,
      controls: [],
      residualLikelihood: null,
      residualImpact: null,
      status: "open",
      note: "",
      ownerUserId: null,
    });
    added.push(lib.title);
  }
  if (body.custom && typeof body.custom === "object") {
    const c = body.custom as Record<string, unknown>;
    const title = str(c.title, 160);
    if (title.length < 3) throw bad("Give the risk a title");
    const category = Object.keys(RISK_CATEGORY_LABELS).includes(
      String(c.category),
    )
      ? String(c.category)
      : "governance";
    uc.risks.push({
      id: randomUUID(),
      code: null,
      category,
      title,
      description: str(c.description, 1000),
      likelihood: scale(c.likelihood ?? 3, "Likelihood"),
      impact: scale(c.impact ?? 3, "Impact"),
      treatment: null,
      controls: [],
      residualLikelihood: null,
      residualImpact: null,
      status: "open",
      note: "",
      ownerUserId: null,
    });
    added.push(title);
  }
  if (uc.risks.length > 100) throw bad("A use case can hold at most 100 risks");
  if (!added.length) throw bad("Choose at least one risk to add");
  uc.markModified("risks");
  history(uc, actor, "risks_added", added.join(", "));
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

export async function updateRisk(
  actor: Actor,
  id: string,
  riskId: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  requireEdit(actor, uc);
  const risk = uc.risks.find((r) => r.id === riskId) as UseCaseRisk | undefined;
  if (!risk) throw notFound("Risk");
  if (body.likelihood !== undefined)
    risk.likelihood = scale(body.likelihood, "Likelihood");
  if (body.impact !== undefined) risk.impact = scale(body.impact, "Impact");
  if (body.note !== undefined) risk.note = str(body.note, 1000);
  if (body.controls !== undefined) {
    if (!Array.isArray(body.controls)) throw bad("Controls must be a list");
    risk.controls = Array.from(
      new Set(
        body.controls.filter(
          (c): c is string => typeof c === "string" && c in CONTROLS,
        ),
      ),
    );
  }
  if (body.residualLikelihood !== undefined)
    risk.residualLikelihood =
      body.residualLikelihood === null
        ? null
        : scale(body.residualLikelihood, "Residual likelihood");
  if (body.residualImpact !== undefined)
    risk.residualImpact =
      body.residualImpact === null
        ? null
        : scale(body.residualImpact, "Residual impact");
  if (body.treatment !== undefined) {
    if (
      !["mitigate", "accept", "avoid", "transfer"].includes(
        String(body.treatment),
      )
    )
      throw bad("Choose how the risk is treated");
    risk.treatment = body.treatment as UseCaseRisk["treatment"];
  }
  if (
    body.treatment !== undefined ||
    body.controls !== undefined ||
    body.note !== undefined ||
    body.residualLikelihood !== undefined ||
    body.residualImpact !== undefined
  ) {
    // The status follows the treatment, so a risk cannot be called treated without saying how.
    if (risk.treatment === "mitigate") {
      const done =
        risk.controls.length > 0 &&
        risk.residualLikelihood != null &&
        risk.residualImpact != null;
      if (
        done &&
        risk.residualLikelihood! * risk.residualImpact! >
          risk.likelihood * risk.impact
      )
        throw bad(
          "The residual risk cannot be higher than the risk before controls",
        );
      risk.status = done ? "mitigated" : "open";
    } else if (risk.treatment === "accept") {
      if (risk.likelihood * risk.impact >= 12 && !actor.isAdmin)
        throw new AppError(
          403,
          "Only a workspace admin can accept a high or critical risk",
          "FORBIDDEN",
        );
      if (risk.note.length < 10)
        throw bad("Say why the risk is accepted (at least 10 characters)");
      risk.status = "accepted";
    } else if (risk.treatment === "avoid" || risk.treatment === "transfer") {
      if (risk.note.length < 10)
        throw bad(
          `Say how the risk is ${risk.treatment === "avoid" ? "avoided" : "transferred"} (at least 10 characters)`,
        );
      risk.status = "mitigated";
      risk.residualLikelihood = risk.residualLikelihood ?? 1;
      risk.residualImpact = risk.residualImpact ?? risk.impact;
    }
  }
  uc.markModified("risks");
  history(
    uc,
    actor,
    "risk_updated",
    `${risk.title}: ${risk.status}${risk.treatment ? ` (${risk.treatment})` : ""}`,
  );
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

export async function removeRisk(actor: Actor, id: string, riskId: string) {
  const uc = await load(actor, id);
  requireEdit(actor, uc);
  const risk = uc.risks.find((r) => r.id === riskId);
  if (!risk) throw notFound("Risk");
  if (uc.stage === "production" && !actor.isAdmin)
    throw new AppError(
      403,
      "Only a workspace admin can remove a risk from a production use case",
      "FORBIDDEN",
    );
  uc.risks = uc.risks.filter((r) => r.id !== riskId);
  uc.markModified("risks");
  history(uc, actor, "risk_removed", risk.title);
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

// ---------------------------------------------------------------------------
// Approvals and lifecycle
// ---------------------------------------------------------------------------

export async function decide(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  if (uc.stage === "retired")
    throw bad("A retired use case cannot be approved");
  const gate = body.gate as Gate;
  const role = body.role as ApproverRole;
  if (!GATES.includes(gate)) throw bad("Unknown approval gate");
  if (!(APPROVER_ROLES as readonly string[]).includes(role))
    throw bad("Unknown approver role");
  if (body.decision !== "approved" && body.decision !== "rejected")
    throw bad("Approve or reject");
  if (!uc.assessment) throw bad("Complete the assessment before approvals");
  if (uc.assessment.tier === "prohibited")
    throw bad("A prohibited use case cannot be approved");
  const settings = await settingsFor(actor.workspaceId);
  const required = requiredApprovals(
    gate,
    uc.assessment.tier,
    (settings.highRiskExtraRoles ?? []) as ApproverRole[],
  );
  if (!required.includes(role))
    throw bad(`${ROLE_LABELS[role]} sign-off is not needed at this gate`);
  if (!canSign(actor, uc, role, settings))
    throw new AppError(
      403,
      `You cannot sign as ${ROLE_LABELS[role]}`,
      "FORBIDDEN",
    );
  const comment = str(body.comment, 1000);
  if (body.decision === "rejected" && comment.length < 5)
    throw bad("Say why you are rejecting it");
  if (body.decision === "approved") {
    // Separation of duties: one person signs one role per gate when someone else could sign.
    const mine = (uc.approvals ?? []).filter(
      (a) =>
        !a.void &&
        a.gate === gate &&
        a.by === actor.userId &&
        a.role !== role &&
        a.decision === "approved",
    );
    const latestMine = mine.filter(
      (a) =>
        [...uc.approvals]
          .reverse()
          .find((x) => !x.void && x.gate === gate && x.role === a.role) === a,
    );
    if (latestMine.length) {
      const admins = await WorkspaceMemberModel.countDocuments({
        workspaceId: actor.workspaceId,
        role: { $in: ["OWNER", "ADMIN"] },
      });
      if (admins > 1)
        throw new AppError(
          403,
          `You already signed as ${ROLE_LABELS[latestMine[0].role]} at this gate. Someone else must sign as ${ROLE_LABELS[role]}.`,
          "FORBIDDEN",
        );
    }
    if (gate === "production") {
      const s = snapshot(uc, await openIssuesOf(uc._id), settings);
      const blocking = requirementsFor({ ...s, stage: "validation" }).filter(
        (r) => !r.met && r.id !== "approved_production" && r.id !== "active",
      );
      if (blocking.length)
        throw bad(
          `Not ready for production approval: ${blocking.map((b) => b.label).join("; ")}`,
        );
    }
  }
  uc.approvals.push({
    gate,
    role,
    decision: body.decision,
    by: actor.userId,
    byName: actor.name,
    at: new Date(),
    comment,
  });
  uc.markModified("approvals");
  history(
    uc,
    actor,
    body.decision === "approved" ? "approved" : "approval_rejected",
    `${ROLE_LABELS[role]} for ${gate}${comment ? `: ${comment}` : ""}`,
  );
  await rescore(uc, settings);
  await persist(uc);
  return detail(uc, actor);
}

export async function advance(actor: Actor, id: string) {
  const uc = await load(actor, id);
  requireEdit(actor, uc);
  const target = nextStage(uc.stage);
  if (!target)
    throw bad(
      uc.stage === "production"
        ? "It is already in production"
        : "A retired use case cannot move on",
    );
  const settings = await settingsFor(actor.workspaceId);
  const s = snapshot(uc, await openIssuesOf(uc._id), settings);
  const unmet = requirementsFor(s).filter((r) => !r.met);
  if (unmet.length)
    throw new AppError(
      409,
      `Not ready for ${STAGE_LABELS[target]}: ${unmet.map((r) => r.label).join("; ")}`,
      "REQUIREMENTS_NOT_MET",
    );
  const from = uc.stage;
  uc.stage = target;
  if (target === "production") {
    const tier = uc.assessment?.tier as Exclude<Tier, "prohibited">;
    const days = uc.reviewDays ?? DEFAULT_REVIEW_DAYS[tier] ?? 180;
    uc.lastAttestedAt = new Date();
    uc.lastAttestedBy = actor.name;
    uc.nextReviewAt = new Date(Date.now() + days * DAY);
    // The inputs it was validated on become the baseline for drift.
    if (!uc.baseline) await captureBaseline(uc);
  }
  history(
    uc,
    actor,
    "stage_changed",
    `${STAGE_LABELS[from]} → ${STAGE_LABELS[target]}`,
  );
  await rescore(uc, settings);
  await persist(uc);
  return detail(uc, actor);
}

export async function transition(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  const action = String(body.action);
  const reason = str(body.reason, 1000);
  if (!["hold", "resume", "reject", "retire", "send_back"].includes(action))
    throw bad("Unknown action");
  if (action !== "retire" || uc.stage === "production") requireAdmin(actor);
  else requireEdit(actor, uc);
  if (uc.stage === "retired") throw bad("It is already retired");
  if (action !== "resume" && reason.length < 5)
    throw bad("Give a reason (at least 5 characters)");
  if (action === "hold") {
    if (uc.status !== "active") throw bad("It is not active");
    uc.status = "on_hold";
    history(uc, actor, "on_hold", reason);
  } else if (action === "resume") {
    if (uc.status !== "on_hold") throw bad("It is not on hold");
    uc.status = "active";
    history(uc, actor, "resumed", reason);
  } else if (action === "reject") {
    if (uc.stage === "production")
      throw bad("Retire a production use case instead");
    uc.status = "rejected";
    history(uc, actor, "rejected", reason);
  } else if (action === "retire") {
    const from = uc.stage;
    uc.stage = "retired";
    uc.nextReviewAt = null;
    history(
      uc,
      actor,
      "stage_changed",
      `${STAGE_LABELS[from]} → Retired: ${reason}`,
    );
    const issues = await AiIssueModel.find({
      useCaseId: uc._id,
      status: { $in: ["open", "in_progress"] },
      source: { $ne: "manual" },
    });
    for (const issue of issues)
      await resolveIssue(issue, null, "The use case was retired.");
  } else {
    const i = STAGES.indexOf(uc.stage);
    if (i <= 0) throw bad("It is already at the first stage");
    const from = uc.stage;
    uc.stage = STAGES[i - 1];
    // Going back means the gate it passed has to be passed again.
    const gate: Gate | null =
      from === "production"
        ? "production"
        : from === "development"
          ? "development"
          : null;
    if (gate) {
      uc.approvals = uc.approvals.map((a) =>
        a.gate === gate ? { ...a, void: true } : a,
      );
      uc.markModified("approvals");
    }
    if (from === "production") uc.nextReviewAt = null;
    history(
      uc,
      actor,
      "stage_changed",
      `${STAGE_LABELS[from]} → ${STAGE_LABELS[uc.stage]} (sent back): ${reason}`,
    );
  }
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

export async function attest(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const uc = await load(actor, id);
  if (uc.stage !== "production")
    throw bad("Only a production use case is reviewed periodically");
  if (String(uc.ownerUserId) !== actor.userId && !actor.isAdmin)
    throw new AppError(
      403,
      "Only the owner or a workspace admin can attest",
      "FORBIDDEN",
    );
  if (body.confirmed !== true)
    throw bad(
      "Confirm that the factsheet, risks and controls are still correct",
    );
  const note = str(body.note, 1000);
  const tier = (uc.assessment?.tier ?? "medium") as Exclude<Tier, "prohibited">;
  const days = uc.reviewDays ?? DEFAULT_REVIEW_DAYS[tier] ?? 180;
  uc.lastAttestedAt = new Date();
  uc.lastAttestedBy = actor.name;
  uc.nextReviewAt = new Date(Date.now() + days * DAY);
  history(
    uc,
    actor,
    "attested",
    `Reviewed and confirmed. Next review in ${days} days.${note ? ` ${note}` : ""}`,
  );
  const review = await AiIssueModel.findOne({
    key: `review:${uc._id}`,
    status: { $in: ["open", "in_progress"] },
  });
  if (review) await resolveIssue(review, null, `Reviewed by ${actor.name}.`);
  await rescore(uc);
  await persist(uc);
  return detail(uc, actor);
}

// ---------------------------------------------------------------------------
// Records and evaluations
// ---------------------------------------------------------------------------

export const MAX_RECORDS_PER_CALL = 200;
const TEXT_LIMIT = 8000;

export async function ingestRecords(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
  source: "api" | "sdk" = "api",
) {
  if (!isId(id)) throw notFound("Use case");
  const uc = await AiUseCaseModel.findOne({
    _id: id,
    workspaceId: actor.workspaceId,
  })
    .select("_id stage workspaceId")
    .lean();
  if (!uc) throw notFound("Use case");
  if (uc.stage === "retired")
    throw bad("A retired use case no longer takes records");
  const list = Array.isArray(body.records)
    ? body.records
    : body.input !== undefined
      ? [body]
      : [];
  if (!list.length) throw bad("Send records: [{ input, output }]");
  if (list.length > MAX_RECORDS_PER_CALL)
    throw bad(`Send at most ${MAX_RECORDS_PER_CALL} records per call`);
  const now = Date.now();
  const docs = list.map((raw, index) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.input !== "string" || typeof r.output !== "string")
      throw bad(`Record ${index + 1}: input and output must be text`);
    const input = r.input.slice(0, TEXT_LIMIT);
    const output = r.output.slice(0, TEXT_LIMIT);
    if (!input.trim() && !output.trim())
      throw bad(`Record ${index + 1}: input and output are both empty`);
    const context =
      typeof r.context === "string" ? r.context.slice(0, TEXT_LIMIT * 4) : null;
    const expected =
      typeof r.expected === "string" ? r.expected.slice(0, TEXT_LIMIT) : null;
    let at = now;
    if (r.at !== undefined) {
      const t = new Date(String(r.at)).getTime();
      if (!Number.isFinite(t) || t > now + 5 * 60000 || t < now - 180 * DAY)
        throw bad(
          `Record ${index + 1}: "at" must be a time in the last 180 days`,
        );
      at = t;
    }
    const latency =
      r.latencyMs === undefined || r.latencyMs === null
        ? null
        : Number(r.latencyMs);
    if (
      latency !== null &&
      (!Number.isFinite(latency) || latency < 0 || latency > 3600000)
    )
      throw bad(
        `Record ${index + 1}: latencyMs must be between 0 and 3,600,000`,
      );
    const scores = scoreRecord({ input, output, context, expected });
    const flags = [
      ...scores.pii.map(
        (k) => `Personal data in the output: ${k.replace(/_/g, " ")}`,
      ),
      ...(scores.harmful ? ["Harmful content in the output"] : []),
      ...(scores.injection ? ["Prompt-injection attempt in the input"] : []),
    ];
    return {
      workspaceId: uc.workspaceId,
      useCaseId: uc._id,
      at: new Date(at),
      // Stored masked: the scores above were computed on the original text.
      input: maskText(input).slice(0, 2000),
      output: maskText(output).slice(0, 2000),
      hasContext: Boolean(context),
      hasExpected: Boolean(expected),
      feedback: (r.feedback === "up" || r.feedback === "down"
        ? r.feedback
        : null) as "up" | "down" | null,
      latencyMs: latency,
      scores,
      flags,
      flagged: flags.length > 0,
      recordId:
        typeof r.recordId === "string" && r.recordId.trim()
          ? r.recordId.trim().slice(0, 64)
          : null,
      source,
    };
  });
  // A retry of a batch that already arrived must not count its interactions twice.
  const ids = docs
    .map((d) => d.recordId)
    .filter((x): x is string => Boolean(x));
  const seen = ids.length
    ? new Set(
        (
          await AiRecordModel.find({
            useCaseId: uc._id,
            recordId: { $in: ids },
          })
            .select("recordId")
            .lean()
        ).map((r) => r.recordId),
      )
    : new Set<string | null | undefined>();
  const fresh = docs.filter((d) => !d.recordId || !seen.has(d.recordId));
  if (fresh.length) {
    await AiRecordModel.insertMany(fresh, { ordered: false });
    await addToBuckets(uc.workspaceId, uc._id, fresh);
  }
  return {
    accepted: docs.length,
    duplicates: docs.length - fresh.length,
    flagged: fresh.filter((d) => d.flagged).length,
  };
}

/**
 * Interactions sent by an app's SDK. The integration's owner decides which
 * workspace they belong to; each record names its use case by reference
 * ("UC-12") or id, and an unknown use case refuses the whole call.
 */
export async function ingestFromIntegration(
  integrationId: string,
  body: unknown,
) {
  const integration = await SdkIntegrationModel.findById(integrationId)
    .select("tenantId")
    .lean();
  if (!integration)
    throw new AppError(401, "Unknown SDK integration", "UNAUTHORIZED");
  const actor = await actorFor(String(integration.tenantId));
  const list =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { records?: unknown }).records)
      ? ((body as { records: unknown[] }).records as Array<
          Record<string, unknown>
        >)
      : [];
  if (!list.length)
    throw bad('Send { "records": [{ "useCase": "UC-1", "input", "output" }] }');
  if (list.length > MAX_RECORDS_PER_CALL)
    throw bad(`Send at most ${MAX_RECORDS_PER_CALL} records per call`);
  const groups = new Map<string, Array<Record<string, unknown>>>();
  list.forEach((r, i) => {
    const key =
      typeof r?.useCase === "string" ? r.useCase.trim().slice(0, 40) : "";
    if (!key)
      throw bad(`Record ${i + 1}: useCase is required (for example "UC-1")`);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  });
  // Resolve every use case first, so an unknown one stores nothing.
  const resolved = new Map<string, string>();
  for (const key of groups.keys()) {
    const found = /^[a-f0-9]{24}$/i.test(key)
      ? await AiUseCaseModel.findOne({
          _id: key,
          workspaceId: actor.workspaceId,
        })
          .select("_id links")
          .lean()
      : await AiUseCaseModel.findOne({
          ref: key.toUpperCase(),
          workspaceId: actor.workspaceId,
        })
          .select("_id links")
          .lean();
    if (!found) throw notFound(`Use case ${key}`);
    // An app's SDK key is public, so a use case only takes interactions from apps it names.
    const allowed = (
      (found.links as { integrationIds?: string[] } | undefined)
        ?.integrationIds ?? []
    ).map(String);
    if (!allowed.includes(integrationId))
      throw new AppError(
        403,
        `Use case ${key} does not accept interactions from this app. Allow the app under Linked assets on the use case's Factsheet tab in AI Governance.`,
        "FORBIDDEN",
      );
    resolved.set(key, String(found._id));
  }
  const out: Record<
    string,
    { accepted: number; duplicates: number; flagged: number }
  > = {};
  for (const [key, records] of groups) {
    out[key] = await ingestRecords(
      actor,
      resolved.get(key)!,
      { records },
      "sdk",
    );
  }
  return { useCases: out };
}

const HOUR = 3600000;
/** How many of a record's keywords go into the hourly drift profile. */
const BUCKET_TERMS = 8;

/** Adds a batch of scored records to the hourly running totals (one upsert per hour touched). */
async function addToBuckets(
  workspaceId: unknown,
  useCaseId: unknown,
  docs: Array<{
    at: Date;
    scores: ReturnType<typeof scoreRecord>;
    feedback: "up" | "down" | null;
  }>,
): Promise<void> {
  const byHour = new Map<number, Totals>();
  for (const d of docs) {
    const hour = Math.floor(d.at.getTime() / HOUR) * HOUR;
    const totals = byHour.get(hour) ?? emptyTotals();
    addRecord(totals, {
      scores: { ...d.scores, terms: d.scores.terms.slice(0, BUCKET_TERMS) },
      feedback: d.feedback,
    });
    byHour.set(hour, totals);
  }
  const ops = [...byHour].map(([hour, t]) => {
    const { terms, ...counts } = t;
    const inc: Record<string, number> = { ...counts };
    for (const [term, count] of Object.entries(terms))
      inc[`terms.${term}`] = count;
    return {
      updateOne: {
        filter: { useCaseId, hour: new Date(hour) },
        update: { $inc: inc, $setOnInsert: { workspaceId } },
        upsert: true,
      },
    };
  });
  // One round trip for every hour a batch touches, not one per hour.
  for (let attempt = 0; ; attempt++) {
    try {
      await AiMetricBucketModel.collection.bulkWrite(ops as never, {
        ordered: false,
      });
      return;
    } catch (error) {
      // Two first writes for the same hour at once: the other created the row, so a second pass is a plain update.
      if (
        !isDuplicateKey(error) &&
        (error as { code?: number })?.code !== 11000 &&
        !/E11000/.test(String((error as Error)?.message))
      )
        throw error;
      if (attempt >= 2) throw error;
    }
  }
}

/** The summed hourly totals of a use case since a time (or over everything kept). */
async function totalsSince(useCaseId: unknown, since?: Date): Promise<Totals> {
  const filter: Record<string, unknown> = { useCaseId };
  if (since)
    filter.hour = { $gte: new Date(Math.floor(since.getTime() / HOUR) * HOUR) };
  const buckets = await AiMetricBucketModel.find(filter).lean();
  return buckets.reduce(
    (sum, b) => addTotals(sum, b as unknown as Totals),
    emptyTotals(),
  );
}

export async function listRecords(
  actor: Actor,
  id: string,
  query: { flagged?: boolean; limit?: number },
) {
  const uc = await load(actor, id);
  const filter: Record<string, unknown> = { useCaseId: uc._id };
  if (query.flagged) filter.flagged = true;
  const rows = await AiRecordModel.find(filter)
    .sort({ at: -1 })
    .limit(Math.min(200, Math.max(1, query.limit ?? 50)))
    .lean();
  const total = (await totalsSince(uc._id)).n;
  return {
    total,
    records: rows.map((r) => ({
      id: String(r._id),
      at: r.at,
      input: r.input,
      output: r.output,
      feedback: r.feedback,
      flags: r.flags,
      source: r.source ?? "api",
      relevance: r.scores?.relevance ?? null,
      faithfulness: r.scores?.faithfulness ?? null,
      correctness: r.scores?.correctness ?? null,
    })),
  };
}

const EVAL_WINDOW_DAYS = 7;
/** Linked AI calls read for error rate and latency. */
const EVAL_MAX_RECORDS = 5000;

async function captureBaseline(uc: IAiUseCaseDocument): Promise<number> {
  const totals = await totalsSince(uc._id, new Date(Date.now() - 30 * DAY));
  if (totals.n < 10) return totals.n;
  uc.baseline = {
    at: new Date(),
    records: totals.n,
    terms: topTerms(totals.terms),
  };
  uc.markModified("baseline");
  return totals.n;
}

export async function setBaseline(actor: Actor, id: string) {
  requireAdmin(actor);
  const uc = await load(actor, id);
  const n = await captureBaseline(uc);
  if (n < 10)
    throw bad("Log at least 10 interactions before setting a baseline");
  history(
    uc,
    actor,
    "baseline_set",
    `Drift baseline set from ${n} interactions`,
  );
  await persist(uc);
  return detail(uc, actor);
}

/** Runs the evaluation over the last week of records and stores the result. */
async function evaluateUseCase(
  uc: IAiUseCaseDocument,
): Promise<MetricResult[]> {
  const since = new Date(Date.now() - EVAL_WINDOW_DAYS * DAY);
  const totals = await totalsSince(uc._id, since);
  let executions: {
    total: number;
    errors: number;
    latencies: number[];
  } | null = null;
  const agentIds = (uc.links?.agentIds ?? []).filter(isId).map(oid);
  const promptIds = (uc.links?.promptIds ?? []).filter(isId).map(oid);
  if (agentIds.length || promptIds.length) {
    const or: Array<Record<string, unknown>> = [];
    if (agentIds.length) or.push({ agentId: { $in: agentIds } });
    if (promptIds.length) or.push({ promptId: { $in: promptIds } });
    const logs = await PromptExecutionLogModel.find({
      workspaceId: uc.workspaceId,
      createdAt: { $gte: since },
      $or: or,
    })
      .select("status latencyMs")
      .limit(EVAL_MAX_RECORDS)
      .lean();
    executions = {
      total: logs.length,
      errors: logs.filter((l) => l.status === "error").length,
      latencies: logs
        .filter((l) => l.status === "success")
        .map((l) => l.latencyMs),
    };
  }
  const tier =
    uc.assessment?.tier && uc.assessment.tier !== "prohibited"
      ? uc.assessment.tier
      : "medium";
  const results = evaluateTotals({
    totals,
    tier,
    thresholds: uc.thresholds ?? {},
    baseline: uc.baseline?.terms ?? null,
    executions,
  });
  uc.evaluation = {
    ranAt: new Date(),
    status: overallStatus(results),
    windowDays: EVAL_WINDOW_DAYS,
    records: totals.n,
    results,
  };
  uc.markModified("evaluation");
  return results;
}

const METRIC_SEVERITY = (key: string, tier: Tier | null): Severity =>
  key === "pii_in_output" || key === "harmful_content"
    ? tier === "low"
      ? "medium"
      : "high"
    : tier === "high"
      ? "high"
      : tier === "low"
        ? "low"
        : "medium";

const formatValue = (r: MetricResult): string =>
  r.value == null
    ? "no data"
    : r.unit === "rate"
      ? `${Math.round(r.value * 1000) / 10}%`
      : r.unit === "ms"
        ? `${Math.round(r.value)} ms`
        : r.value.toFixed(2);
const formatThreshold = (r: MetricResult): string =>
  `${r.direction === "max" ? "at most" : "at least"} ${r.unit === "rate" ? `${Math.round(r.threshold * 1000) / 10}%` : r.unit === "ms" ? `${r.threshold} ms` : r.threshold.toFixed(2)}`;

/** Opens an issue for each failing metric and closes the ones that recovered. Only once it is in production. */
async function syncEvaluationIssues(
  uc: IAiUseCaseDocument,
  results: MetricResult[],
): Promise<{ opened: number; resolved: number }> {
  let opened = 0;
  let resolved = 0;
  if (uc.stage !== "production") return { opened, resolved };
  for (const r of results) {
    const key = `evaluation:${uc._id}:${r.key}`;
    const open = await AiIssueModel.findOne({
      key,
      status: { $in: ["open", "in_progress"] },
    });
    if (r.status === "fail" && !open) {
      const created = await createIssueDoc({
        workspaceId: String(uc.workspaceId),
        useCase: uc,
        title: `${r.label} is out of bounds for ${uc.name}`,
        description: `${r.label} is ${formatValue(r)} over the last ${EVAL_WINDOW_DAYS} days (${r.samples} samples). It should be ${formatThreshold(r)}.`,
        severity: METRIC_SEVERITY(r.key, uc.assessment?.tier ?? null),
        source: "evaluation",
        key,
        metricKey: r.key,
        ownerUserId: String(uc.ownerUserId),
        actor: null,
      });
      if (created) opened++;
    } else if (r.status === "pass" && open) {
      await resolveIssue(
        open,
        null,
        `${r.label} is back within bounds: ${formatValue(r)}.`,
      );
      resolved++;
    }
  }
  return { opened, resolved };
}

const evaluating = new Map<string, Promise<unknown>>();

export async function runEvaluation(actor: Actor, id: string) {
  const first = await load(actor, id);
  if (first.stage === "retired")
    throw bad("A retired use case is not evaluated");
  // Asking for the same evaluation while one is running joins it: the result would be the same.
  const running = evaluating.get(String(first._id));
  if (running) {
    await running.catch(() => undefined);
    return detail(await load(actor, id), actor);
  }
  const job = evaluateAndSave(actor, first);
  evaluating.set(String(first._id), job);
  try {
    await job;
  } finally {
    evaluating.delete(String(first._id));
  }
  return detail(await load(actor, id), actor);
}

async function evaluateAndSave(
  actor: Actor,
  first: IAiUseCaseDocument,
): Promise<void> {
  // The hourly job and other servers can save at the same time: each run re-applies on the latest copy instead of failing.
  const done = await mutate(first._id, async (uc) => {
    const results = await evaluateUseCase(uc);
    history(
      uc,
      actor,
      "evaluated",
      `${
        uc.evaluation?.status === "pass"
          ? "Passed"
          : uc.evaluation?.status === "fail"
            ? `Failed: ${results
                .filter((r) => r.status === "fail")
                .map((r) => r.label)
                .join(", ")}`
            : "Not enough data"
      } (${uc.evaluation?.records ?? 0} interactions)`,
    );
    await syncEvaluationIssues(uc, results);
    await rescore(uc);
  });
  if (!done) throw notFound("Use case");
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

const issueTaskKey = (issueId: string) => `ai_issue:${issueId}`;

async function closeIssueTask(issueId: string, reason: string): Promise<void> {
  try {
    const link = await AutomationLinkModel.findOne({
      key: issueTaskKey(issueId),
      state: "open",
    });
    if (link) await closeTask(link, reason);
  } catch (error) {
    logger.warn("Could not close the task of an AI governance issue", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createIssueDoc(input: {
  workspaceId: string;
  useCase: Pick<IAiUseCaseDocument, "_id" | "name" | "ref">;
  title: string;
  description: string;
  severity: Severity;
  source: "manual" | "evaluation" | "review";
  key: string | null;
  metricKey: string | null;
  ownerUserId: string;
  dueAt?: Date | null;
  actions?: string[];
  actor: Actor | null;
}): Promise<IAiIssueDocument | null> {
  const dueDays = { critical: 2, high: 7, medium: 30, low: 90 }[input.severity];
  const _id = new Types.ObjectId();
  const issue = new AiIssueModel({
    _id,
    openKey: input.key ?? `manual:${_id}`,
    workspaceId: input.workspaceId,
    useCaseId: input.useCase._id,
    title: input.title.slice(0, 200),
    description: input.description,
    severity: input.severity,
    source: input.source,
    key: input.key,
    metricKey: input.metricKey,
    ownerUserId: input.ownerUserId,
    dueAt: input.dueAt ?? new Date(Date.now() + dueDays * DAY),
    actions: (input.actions ?? []).slice(0, 20).map((title) => ({
      id: randomUUID(),
      title: title.slice(0, 200),
      done: false,
      doneAt: null,
      doneBy: null,
    })),
    createdBy: input.actor?.userId ?? null,
    history: [],
  });
  history(
    issue,
    input.actor,
    "opened",
    input.source === "manual" ? "" : "Opened automatically",
  );
  try {
    await issue.save();
  } catch (error) {
    // The same condition was opened by another request a moment ago: one issue is enough.
    if (isDuplicateKey(error) && input.key) return null;
    throw error;
  }
  overviewCache.delete(input.workspaceId);
  // The owner gets a task, and admins an alert for the serious ones.
  try {
    await openTask(
      {
        rule: "ai_governance",
        key: issueTaskKey(String(issue._id)),
        title: `AI issue: ${issue.title}`,
        description: `${issue.description || issue.title}\n\nUse case: ${input.useCase.ref} ${input.useCase.name}.`,
        priority: (
          {
            critical: "CRITICAL",
            high: "HIGH",
            medium: "MEDIUM",
            low: "LOW",
          } as const
        )[input.severity],
        assigneeUserId: input.ownerUserId,
        link: `/ai-governance/use-cases/${input.useCase._id}?tab=issues`,
      },
      input.workspaceId,
      { enabled: true, projectId: null } as never,
    );
  } catch (error) {
    logger.warn("Could not open a task for an AI governance issue", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (input.severity === "high" || input.severity === "critical") {
    await raiseAlert({
      workspaceId: input.workspaceId,
      type: "ai_governance_issue",
      severity: input.severity === "critical" ? "critical" : "warning",
      title: issue.title,
      detail: issue.description.slice(0, 400),
      dedupeKey: `ai_issue:${issue._id}`,
    }).catch(() => undefined);
  }
  return issue;
}

async function resolveIssue(
  issue: IAiIssueDocument,
  actor: Actor | null,
  resolution: string,
  status: IssueStatus = "resolved",
): Promise<void> {
  issue.status = status;
  issue.openKey = `closed:${issue._id}`;
  issue.resolution = resolution.slice(0, 2000);
  issue.resolvedAt = new Date();
  overviewCache.delete(String(issue.workspaceId));
  history(issue, actor, status, resolution);
  await issue.save();
  await closeIssueTask(
    String(issue._id),
    status === "accepted"
      ? "the issue was accepted."
      : "the issue was resolved.",
  );
}

const issueView = (
  i: IAiIssueDocument | Record<string, unknown>,
  names?: Map<string, { name: string; ref: string }>,
) => {
  const x = i as unknown as IAiIssueDocument;
  const uc = names?.get(String(x.useCaseId));
  return {
    id: String(x._id),
    useCaseId: String(x.useCaseId),
    useCaseName: uc?.name ?? null,
    useCaseRef: uc?.ref ?? null,
    title: x.title,
    description: x.description,
    severity: x.severity,
    status: x.status,
    source: x.source,
    metricKey: x.metricKey,
    ownerUserId: String(x.ownerUserId),
    dueAt: x.dueAt,
    overdue: Boolean(
      x.dueAt &&
      (x.status === "open" || x.status === "in_progress") &&
      new Date(x.dueAt).getTime() < Date.now(),
    ),
    actions: x.actions ?? [],
    resolution: x.resolution,
    resolvedAt: x.resolvedAt,
    createdAt: x.createdAt,
    history: [...(x.history ?? [])].reverse().slice(0, 50),
  };
};

export async function listIssues(
  actor: Actor,
  filter: { status?: string; useCaseId?: string },
) {
  const query: Record<string, unknown> = { workspaceId: actor.workspaceId };
  if (filter.status === "open") query.status = { $in: ["open", "in_progress"] };
  else if (
    filter.status &&
    (ISSUE_STATUSES as readonly string[]).includes(filter.status)
  )
    query.status = filter.status;
  if (filter.useCaseId) {
    if (!isId(filter.useCaseId)) return [];
    query.useCaseId = filter.useCaseId;
  }
  const rows = await AiIssueModel.find(query)
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  const ucs = await AiUseCaseModel.find({
    _id: { $in: Array.from(new Set(rows.map((r) => String(r.useCaseId)))) },
  })
    .select("name ref")
    .lean();
  const names = new Map(
    ucs.map((u) => [String(u._id), { name: u.name, ref: u.ref }]),
  );
  return rows.map((r) => issueView(r as never, names));
}

/** Refreshes the stored score after an issue changed. Retries once if the use case was saved in between. */
async function touchUseCase(useCaseId: unknown): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const uc = await AiUseCaseModel.findById(useCaseId);
    if (!uc) return;
    await rescore(uc);
    try {
      await uc.save();
      return;
    } catch (error) {
      if (
        (error as { name?: string })?.name !== "VersionError" ||
        attempt === 1
      ) {
        logger.warn("Could not refresh a use case score", {
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }
}

export async function createIssue(actor: Actor, body: Record<string, unknown>) {
  const uc = await load(actor, String(body.useCaseId ?? ""));
  const title = str(body.title, 200);
  if (title.length < 5)
    throw bad("Give the issue a title of at least 5 characters");
  const severity = (SEVERITIES as readonly string[]).includes(
    String(body.severity),
  )
    ? (body.severity as Severity)
    : "medium";
  let dueAt: Date | null = null;
  if (body.dueAt) {
    dueAt = new Date(String(body.dueAt));
    if (Number.isNaN(dueAt.getTime())) throw bad("The due date is not a date");
  }
  const ownerUserId = isId(body.ownerUserId)
    ? body.ownerUserId
    : String(uc.ownerUserId);
  const member = await WorkspaceMemberModel.findOne({
    workspaceId: actor.workspaceId,
    userId: ownerUserId,
    role: { $ne: "GUEST" },
  }).lean();
  if (!member) throw bad("The issue owner must be a member of this workspace");
  const actions = Array.isArray(body.actions)
    ? body.actions
        .filter(
          (a): a is string => typeof a === "string" && a.trim().length > 0,
        )
        .map((a) => a.trim())
    : [];
  const issue = await createIssueDoc({
    workspaceId: actor.workspaceId,
    useCase: uc,
    title,
    description: str(body.description, 4000),
    severity,
    source: "manual",
    key: null,
    metricKey: null,
    ownerUserId,
    dueAt,
    actions,
    actor,
  });
  if (!issue) throw new AppError(409, "This issue is already open", "CONFLICT");
  history(uc, actor, "issue_opened", title);
  await rescore(uc);
  await persist(uc);
  return issueView(issue);
}

export async function updateIssue(
  actor: Actor,
  issueId: string,
  body: Record<string, unknown>,
) {
  if (!isId(issueId)) throw notFound("Issue");
  const issue = await AiIssueModel.findOne({
    _id: issueId,
    workspaceId: actor.workspaceId,
  });
  if (!issue) throw notFound("Issue");
  if (!actor.isAdmin && String(issue.ownerUserId) !== actor.userId)
    throw new AppError(
      403,
      "Only the issue owner or a workspace admin can change it",
      "FORBIDDEN",
    );
  const closed = issue.status === "resolved" || issue.status === "accepted";
  if (body.severity !== undefined) {
    if (!(SEVERITIES as readonly string[]).includes(String(body.severity)))
      throw bad("Unknown severity");
    if (body.severity !== issue.severity)
      history(issue, actor, "severity", `${issue.severity} → ${body.severity}`);
    issue.severity = body.severity as Severity;
  }
  if (body.description !== undefined)
    issue.description = str(body.description, 4000);
  if (body.dueAt !== undefined) {
    const d = body.dueAt ? new Date(String(body.dueAt)) : null;
    if (d && Number.isNaN(d.getTime())) throw bad("The due date is not a date");
    issue.dueAt = d;
  }
  if (body.addAction !== undefined) {
    const title = str(body.addAction, 200);
    if (title.length < 3) throw bad("Describe the action");
    if (issue.actions.length >= 20)
      throw bad("An issue can hold at most 20 actions");
    issue.actions.push({
      id: randomUUID(),
      title,
      done: false,
      doneAt: null,
      doneBy: null,
    });
    issue.markModified("actions");
  }
  if (body.toggleAction !== undefined) {
    const action = issue.actions.find((a) => a.id === body.toggleAction);
    if (!action) throw notFound("Action");
    action.done = !action.done;
    action.doneAt = action.done ? new Date() : null;
    action.doneBy = action.done ? actor.name : null;
    issue.markModified("actions");
  }
  if (body.status !== undefined) {
    const status = String(body.status) as IssueStatus;
    if (!(ISSUE_STATUSES as readonly string[]).includes(status))
      throw bad("Unknown status");
    if (status !== issue.status) {
      if (status === "resolved" || status === "accepted") {
        const resolution = str(body.resolution, 2000);
        if (resolution.length < 10)
          throw bad(
            status === "accepted"
              ? "Say why the issue is accepted (at least 10 characters)"
              : "Say how the issue was resolved (at least 10 characters)",
          );
        if (status === "accepted" && !actor.isAdmin)
          throw new AppError(
            403,
            "Only a workspace admin can accept an issue without fixing it",
            "FORBIDDEN",
          );
        if (status === "resolved" && issue.actions.some((a) => !a.done))
          throw bad("Finish or remove the open actions first");
        await resolveIssue(issue, actor, resolution, status);
        await touchUseCase(issue.useCaseId);
        return issueView(issue);
      }
      if (closed) {
        issue.resolvedAt = null;
        issue.resolution = "";
        issue.openKey = issue.key ?? `manual:${issue._id}`;
      }
      issue.status = status;
      history(issue, actor, closed ? "reopened" : status, "");
    }
  }
  overviewCache.delete(actor.workspaceId);
  try {
    await issue.save();
  } catch (error) {
    if (isDuplicateKey(error))
      throw new AppError(
        409,
        "A newer issue for the same problem is already open",
        "CONFLICT",
      );
    throw error;
  }
  await touchUseCase(issue.useCaseId);
  return issueView(issue);
}

// ---------------------------------------------------------------------------
// Overview, discovery, reports
// ---------------------------------------------------------------------------

export async function overview(actor: Actor) {
  const hit = overviewCache.get(actor.workspaceId);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS)
    return hit.data as Awaited<ReturnType<typeof computeOverview>>;
  const data = await computeOverview(actor);
  overviewCache.set(actor.workspaceId, { at: Date.now(), data });
  if (overviewCache.size > 5000) overviewCache.clear();
  return data;
}

async function computeOverview(actor: Actor) {
  const [ucs, issues, ungov] = await Promise.all([
    AiUseCaseModel.find({ workspaceId: actor.workspaceId })
      .select(
        "name ref stage status assessment score evaluation nextReviewAt risks ownerUserId updatedAt type description",
      )
      .lean(),
    AiIssueModel.find({
      workspaceId: actor.workspaceId,
      status: { $in: ["open", "in_progress"] },
    })
      .select("severity dueAt")
      .lean(),
    ungoverned(actor),
  ]);
  const live = ucs.filter(
    (u) => u.stage !== "retired" && u.status !== "rejected",
  );
  const count = <T extends string>(
    keys: readonly T[],
    pick: (u: (typeof ucs)[number]) => string | null | undefined,
  ) =>
    Object.fromEntries(
      keys.map((k) => [k, live.filter((u) => pick(u) === k).length]),
    ) as Record<T, number>;
  const now = Date.now();
  const production = live.filter((u) => u.stage === "production");
  const allRisks = live.flatMap((u) => (u.risks ?? []) as UseCaseRisk[]);
  return {
    total: live.length,
    byStage: count(STAGES, (u) => u.stage),
    byTier: {
      ...count(["low", "medium", "high"] as const, (u) => u.assessment?.tier),
      unassessed: live.filter((u) => !u.assessment).length,
    },
    byEuCategory: count(
      ["high", "limited", "minimal", "out_of_scope"] as const,
      (u) => u.assessment?.eu?.category,
    ),
    prohibited: ucs.filter((u) => u.assessment?.tier === "prohibited").length,
    averageScore: live.length
      ? Math.round(live.reduce((s, u) => s + (u.score ?? 0), 0) / live.length)
      : null,
    productionScore: production.length
      ? Math.round(
          production.reduce((s, u) => s + (u.score ?? 0), 0) /
            production.length,
        )
      : null,
    failingEvaluations: live.filter((u) => u.evaluation?.status === "fail")
      .length,
    notEvaluated: production.filter(
      (u) =>
        !u.evaluation || now - new Date(u.evaluation.ranAt).getTime() > 8 * DAY,
    ).length,
    overdueReviews: production.filter(
      (u) => u.nextReviewAt && new Date(u.nextReviewAt).getTime() < now,
    ).length,
    openIssues: {
      total: issues.length,
      ...Object.fromEntries(
        SEVERITIES.map((s) => [
          s,
          issues.filter((i) => i.severity === s).length,
        ]),
      ),
      overdue: issues.filter(
        (i) => i.dueAt && new Date(i.dueAt).getTime() < now,
      ).length,
    },
    risks: {
      total: allRisks.length,
      untreated: allRisks.filter((r) => r.status === "open").length,
      heatmap: heatmap(allRisks),
    },
    ungoverned: { agents: ungov.agents.length, prompts: ungov.prompts.length },
    attention: [...live]
      .filter(
        (u) =>
          u.evaluation?.status === "fail" ||
          (u.nextReviewAt && new Date(u.nextReviewAt).getTime() < now) ||
          (u.stage === "production" && (u.score ?? 0) < 70),
      )
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      .slice(0, 8)
      .map((u) => ({
        ...summary(u as never),
        reason:
          u.evaluation?.status === "fail"
            ? "Evaluation failing"
            : u.nextReviewAt && new Date(u.nextReviewAt).getTime() < now
              ? "Review overdue"
              : "Low governance score",
      })),
  };
}

/** AI that is running but belongs to no use case: the intake queue. */
export async function ungoverned(actor: Actor) {
  const ucs = await AiUseCaseModel.find({
    workspaceId: actor.workspaceId,
    stage: { $ne: "retired" },
  })
    .select("links")
    .lean();
  const linkedAgents = new Set(ucs.flatMap((u) => u.links?.agentIds ?? []));
  const linkedPrompts = new Set(ucs.flatMap((u) => u.links?.promptIds ?? []));
  const [agents, prompts] = await Promise.all([
    AgentModel.find({
      workspaceId: actor.workspaceId,
      status: { $in: ["active", "suspended"] },
    })
      .select("name kind status lastSeenAt riskLevel")
      .limit(500)
      .lean(),
    PromptLibraryModel.find({
      workspaceId: actor.workspaceId,
      isLatest: true,
      isArchived: false,
    })
      .select("name category updatedAt")
      .limit(500)
      .lean(),
  ]);
  return {
    agents: agents
      .filter((a) => !linkedAgents.has(String(a._id)))
      .map((a) => ({
        id: String(a._id),
        name: a.name,
        kind: a.kind,
        status: a.status,
      })),
    prompts: prompts
      .filter((p) => !linkedPrompts.has(String(p._id)))
      .map((p) => ({
        id: String(p._id),
        name: p.name,
        category: (p as { category?: string }).category ?? null,
      })),
  };
}

export async function assets(actor: Actor) {
  const [agents, prompts, vendors] = await Promise.all([
    AgentModel.find({
      workspaceId: actor.workspaceId,
      status: { $ne: "revoked" },
    })
      .select("name kind")
      .limit(500)
      .lean(),
    PromptLibraryModel.find({
      workspaceId: actor.workspaceId,
      isLatest: true,
      isArchived: false,
    })
      .select("name")
      .limit(500)
      .lean(),
    VendorModel.find({ workspaceId: actor.workspaceId })
      .select("name")
      .limit(500)
      .lean(),
  ]);
  const memberIds = (await members(actor.workspaceId)).map((m) => m.id);
  const integrations = await SdkIntegrationModel.find({
    tenantId: { $in: memberIds },
  })
    .select("name")
    .limit(200)
    .lean();
  return {
    integrations: integrations.map((i) => ({
      id: String(i._id),
      name: String(i.name),
    })),
    agents: agents.map((a) => ({
      id: String(a._id),
      name: a.name,
      kind: a.kind,
    })),
    prompts: prompts.map((p) => ({ id: String(p._id), name: p.name })),
    vendors: vendors.map((v) => ({ id: String(v._id), name: v.name })),
  };
}

export async function getSettings(actor: Actor) {
  const s = await settingsFor(actor.workspaceId);
  return {
    approvers: s.approvers ?? {},
    highRiskExtraRoles: s.highRiskExtraRoles ?? [],
    members: await members(actor.workspaceId),
  };
}

export async function updateSettings(
  actor: Actor,
  body: Record<string, unknown>,
) {
  requireAdmin(actor);
  const s = await settingsFor(actor.workspaceId);
  if (body.approvers !== undefined) {
    const valid = new Set((await members(actor.workspaceId)).map((m) => m.id));
    const next: Record<string, string[]> = {};
    for (const role of APPROVER_ROLES) {
      if (role === "owner") continue;
      const list = (body.approvers as Record<string, unknown> | null)?.[role];
      if (Array.isArray(list))
        next[role] = Array.from(
          new Set(
            list.filter(
              (id): id is string => typeof id === "string" && valid.has(id),
            ),
          ),
        );
    }
    s.approvers = next;
    s.markModified("approvers");
  }
  if (body.highRiskExtraRoles !== undefined) {
    if (!Array.isArray(body.highRiskExtraRoles))
      throw bad("highRiskExtraRoles must be a list");
    s.highRiskExtraRoles = body.highRiskExtraRoles.filter(
      (r): r is ApproverRole => r === "security",
    );
  }
  await s.save();
  return getSettings(actor);
}

export async function inventoryRows(
  actor: Actor,
): Promise<{ header: string[]; rows: unknown[][] }> {
  const ucs = await AiUseCaseModel.find({ workspaceId: actor.workspaceId })
    .sort({ ref: 1 })
    .lean();
  const names = new Map(
    (await members(actor.workspaceId)).map((m) => [m.id, m.name]),
  );
  return {
    header: [
      "Ref",
      "Name",
      "Type",
      "Stage",
      "Status",
      "Risk tier",
      "EU AI Act",
      "Owner",
      "Governance score",
      "Evaluation",
      "Risks",
      "Untreated risks",
      "Next review",
      "Model",
      "Provider",
      "Updated",
    ],
    rows: ucs.map((u) => [
      u.ref,
      u.name,
      u.type,
      STAGE_LABELS[u.stage],
      u.status,
      u.assessment?.tier ?? "not assessed",
      u.assessment?.eu?.category?.replace(/_/g, " ") ?? "",
      names.get(String(u.ownerUserId)) ?? "",
      u.score ?? 0,
      u.evaluation?.status ?? "not run",
      (u.risks ?? []).length,
      ((u.risks ?? []) as UseCaseRisk[]).filter((r) => r.status === "open")
        .length,
      u.nextReviewAt ? new Date(u.nextReviewAt).toISOString().slice(0, 10) : "",
      (u.factsheet as Factsheet | undefined)?.modelName ?? "",
      (u.factsheet as Factsheet | undefined)?.modelProvider ?? "",
      new Date(u.updatedAt).toISOString().slice(0, 10),
    ]),
  };
}

/** The factsheet as a document: everything an auditor asks for about one use case. */
export async function factsheetMarkdown(
  actor: Actor,
  id: string,
): Promise<{ filename: string; body: string }> {
  const uc = await load(actor, id);
  const d = await detail(uc, actor);
  const names = new Map(
    (await members(actor.workspaceId)).map((m) => [m.id, m.name]),
  );
  const day = (v: unknown) =>
    v ? new Date(v as string).toISOString().slice(0, 10) : "—";
  const esc = (v: unknown) =>
    String(v ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n+/g, " ");
  const lines: string[] = [
    `# AI factsheet: ${uc.ref} ${uc.name}`,
    "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by ${actor.name}.`,
    "",
    "## Summary",
    "",
    `| | |`,
    `|---|---|`,
    `| Stage | ${STAGE_LABELS[uc.stage]}${uc.status !== "active" ? ` (${uc.status.replace("_", " ")})` : ""} |`,
    `| Type | ${uc.type} |`,
    `| Owner | ${esc(names.get(String(uc.ownerUserId)) ?? "Unknown")} |`,
    `| Risk tier | ${uc.assessment?.tier ?? "not assessed"} |`,
    `| EU AI Act | ${uc.assessment?.eu?.category?.replace(/_/g, " ") ?? "not assessed"}${uc.assessment?.eu?.role ? ` (${uc.assessment.eu.role})` : ""} |`,
    `| Governance score | ${d.score} / 100 |`,
    `| Last review | ${day(uc.lastAttestedAt)}${uc.lastAttestedBy ? ` by ${esc(uc.lastAttestedBy)}` : ""} |`,
    `| Next review | ${day(uc.nextReviewAt)} |`,
    "",
    uc.description ? `${uc.description}\n` : "",
    "## Factsheet",
    "",
    ...FACTSHEET_FIELDS.flatMap((f) => [
      `**${f.label}.** ${(uc.factsheet as Factsheet)?.[f.key] || "_Not provided._"}`,
      "",
    ]),
    "## Assessment",
    "",
    ...(uc.assessment
      ? [
          `Risk tier **${uc.assessment.tier}**, assessed ${day(uc.assessment.completedAt)} by ${esc(uc.assessment.by)}.`,
          "",
          ...uc.assessment.reasons.map((r) => `- ${r}`),
          "",
          `EU AI Act category: **${uc.assessment.eu.category.replace(/_/g, " ")}**.`,
          "",
          ...uc.assessment.eu.reasons.map((r) => `- ${r}`),
          "",
          ...(uc.assessment.eu.obligations.length
            ? [
                "| Article | Obligation | What it asks |",
                "|---|---|---|",
                ...uc.assessment.eu.obligations.map(
                  (o) =>
                    `| ${o.article} | ${esc(o.title)} | ${esc(o.detail)} |`,
                ),
                "",
              ]
            : []),
        ]
      : ["_Not assessed yet._", ""]),
    "## Risks",
    "",
    ...(d.riskList.length
      ? [
          "| Risk | Before controls | Treatment | Controls | After controls | Status |",
          "|---|---|---|---|---|---|",
          ...d.riskList.map(
            (r) =>
              `| ${esc(r.title)} | ${r.likelihood}×${r.impact} | ${r.treatment ?? "—"} | ${esc(r.controls.map((c) => CONTROLS[c] ?? c).join("; ") || r.note || "—")} | ${r.residualLikelihood && r.residualImpact ? `${r.residualLikelihood}×${r.residualImpact}` : "—"} | ${r.status} |`,
          ),
          "",
        ]
      : ["_No risks recorded._", ""]),
    "## Evaluation",
    "",
    ...(uc.evaluation
      ? [
          `Last run ${day(uc.evaluation.ranAt)} over ${uc.evaluation.records} interactions from the previous ${uc.evaluation.windowDays} days: **${uc.evaluation.status.replace("_", " ")}**.`,
          "",
          "| Metric | Value | Should be | Samples | Result |",
          "|---|---|---|---|---|",
          ...uc.evaluation.results.map(
            (r) =>
              `| ${r.label} | ${formatValue(r)} | ${formatThreshold(r)} | ${r.samples} | ${r.status.replace("_", " ")} |`,
          ),
          "",
        ]
      : ["_Not evaluated yet._", ""]),
    "## Approvals",
    "",
    ...((uc.approvals ?? []).length
      ? [
          "| Gate | Role | Decision | By | Date | Comment |",
          "|---|---|---|---|---|---|",
          ...uc.approvals.map(
            (a) =>
              `| ${a.gate} | ${ROLE_LABELS[a.role]} | ${a.decision}${a.void ? " (superseded)" : ""} | ${esc(a.byName)} | ${day(a.at)} | ${esc(a.comment)} |`,
          ),
          "",
        ]
      : ["_No approvals yet._", ""]),
    "## Open issues",
    "",
    ...(d.openIssues.length
      ? d.openIssues.map((i) => `- [${i.severity}] ${i.title}`)
      : ["_None._"]),
    "",
    "## History",
    "",
    ...[...(uc.history ?? [])]
      .slice(-60)
      .map(
        (h) =>
          `- ${new Date(h.at).toISOString().slice(0, 16).replace("T", " ")} · ${h.byName} · ${h.action.replace(/_/g, " ")}${h.detail ? `: ${h.detail}` : ""}`,
      ),
    "",
  ];
  return { filename: `${uc.ref}-factsheet.md`, body: lines.join("\n") };
}

export function catalogView() {
  return {
    stages: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] })),
    roles: APPROVER_ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })),
    metrics: METRICS,
    metricKeys: METRIC_KEYS,
    controls: CONTROLS,
    riskCategories: RISK_CATEGORY_LABELS,
    riskLibrary: RISK_LIBRARY.map((r) => ({
      code: r.code,
      category: r.category,
      title: r.title,
      description: r.description,
      controls: r.controls,
    })),
    factsheetFields: FACTSHEET_FIELDS,
    reviewDays: DEFAULT_REVIEW_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Scheduled monitoring
// ---------------------------------------------------------------------------

/** Hourly: evaluate everything in validation and production, and flag overdue reviews. */
export async function monitorUseCases(now = Date.now()): Promise<{
  evaluated: number;
  issuesOpened: number;
  issuesResolved: number;
  reviewsFlagged: number;
}> {
  const out = {
    evaluated: 0,
    issuesOpened: 0,
    issuesResolved: 0,
    reviewsFlagged: 0,
  };
  const ids = await AiUseCaseModel.find({
    stage: { $in: ["validation", "production"] },
    status: "active",
  })
    .select("_id")
    .limit(2000)
    .lean();
  for (const { _id } of ids) {
    try {
      await mutate(_id, async (uc) => {
        const results = await evaluateUseCase(uc);
        const synced = await syncEvaluationIssues(uc, results);
        out.evaluated++;
        out.issuesOpened += synced.opened;
        out.issuesResolved += synced.resolved;
        if (
          uc.stage === "production" &&
          uc.nextReviewAt &&
          uc.nextReviewAt.getTime() < now
        ) {
          const key = `review:${uc._id}`;
          const open = await AiIssueModel.findOne({
            key,
            status: { $in: ["open", "in_progress"] },
          });
          if (!open) {
            const created = await createIssueDoc({
              workspaceId: String(uc.workspaceId),
              useCase: uc,
              title: `Periodic review is overdue for ${uc.name}`,
              description: `The review was due on ${uc.nextReviewAt.toISOString().slice(0, 10)}. Check that the factsheet, risks and controls are still correct, then attest.`,
              severity: uc.assessment?.tier === "high" ? "high" : "medium",
              source: "review",
              key,
              metricKey: null,
              ownerUserId: String(uc.ownerUserId),
              actor: null,
            });
            if (created) out.reviewsFlagged++;
          }
        }
        await rescore(uc);
      });
    } catch (error) {
      logger.warn("AI use case monitoring failed for one use case", {
        id: String(_id),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
