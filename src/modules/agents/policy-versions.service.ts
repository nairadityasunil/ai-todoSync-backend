import { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import { diffPolicies, summarizeSimulation, type Effect, type PolicySnapshot } from "./advanced.js";
import { AgentPolicyVersionModel, type IAgentPolicyVersionDocument } from "./advanced.model.js";
import { invalidatePolicies, loadPolicies } from "./guard.js";
import { logGovernanceEvent } from "./hybrid.service.js";
import { AgentActivityModel, AgentModel, AgentPolicyModel, type IAgentPolicyDocument } from "./model.js";
import { evaluatePolicies, type PolicyLike } from "./policy-engine.js";

/* ------------------------------------------------------------------ */
/* Versions                                                             */
/* ------------------------------------------------------------------ */

export const snapshotOf = (policy: Pick<IAgentPolicyDocument, "name" | "description" | "effect" | "mode" | "priority" | "enabled" | "match"> | Record<string, unknown>): PolicySnapshot => {
  const p = policy as Record<string, unknown>;
  const match = JSON.parse(JSON.stringify(p.match ?? {})) as Record<string, unknown>;
  return {
    name: String(p.name ?? ""),
    description: String(p.description ?? ""),
    effect: String(p.effect ?? "allow"),
    mode: String(p.mode ?? "advisory"),
    priority: Number(p.priority ?? 100),
    enabled: p.enabled !== false,
    match,
  };
};

async function nextVersion(policyId: Types.ObjectId | string): Promise<number> {
  const last = await AgentPolicyVersionModel.findOne({ policyId }).sort({ version: -1 }).select("version").lean();
  return (last?.version ?? 0) + 1;
}

/** Policies created before versioning get their current state as version 1. */
export async function ensureBaseVersion(policy: IAgentPolicyDocument): Promise<void> {
  const exists = await AgentPolicyVersionModel.exists({ policyId: policy._id, status: "applied" });
  if (exists) return;
  await AgentPolicyVersionModel.create({
    workspaceId: policy.workspaceId,
    policyId: policy._id,
    version: await nextVersion(policy._id),
    action: "created",
    status: "applied",
    snapshot: snapshotOf(policy),
    previous: null,
    changedBy: policy.updatedBy ?? policy.createdBy,
    createdAt: (policy as unknown as { createdAt?: Date }).createdAt ?? new Date(),
  });
}

export async function recordVersion(input: {
  workspaceId: Types.ObjectId | string;
  policyId: Types.ObjectId | string;
  action: "created" | "updated" | "deleted" | "rolled_back";
  status: "applied" | "proposed";
  snapshot: PolicySnapshot | null;
  previous: PolicySnapshot | null;
  userId: string;
  note?: string | null;
}): Promise<IAgentPolicyVersionDocument> {
  return AgentPolicyVersionModel.create({
    workspaceId: input.workspaceId,
    policyId: input.policyId,
    version: await nextVersion(input.policyId),
    action: input.action,
    status: input.status,
    snapshot: input.snapshot,
    previous: input.previous,
    changedBy: input.userId,
    note: input.note ?? null,
  });
}

/** Makes the live policy match a snapshot: update, re-create (same id) or delete. */
export async function applySnapshot(workspaceId: Types.ObjectId | string, policyId: Types.ObjectId | string, snapshot: PolicySnapshot | null, userId: string): Promise<IAgentPolicyDocument | null> {
  const existing = await AgentPolicyModel.findOne({ _id: policyId, workspaceId });
  let result: IAgentPolicyDocument | null = null;
  if (!snapshot) {
    if (existing) await existing.deleteOne();
  } else if (existing) {
    existing.set({ ...snapshot, updatedBy: userId });
    result = await existing.save();
  } else {
    result = await AgentPolicyModel.create({ _id: new Types.ObjectId(String(policyId)), ...snapshot, workspaceId, createdBy: userId, updatedBy: userId });
  }
  invalidatePolicies(String(workspaceId));
  return result;
}

export const serializeVersion = (v: IAgentPolicyVersionDocument | Record<string, unknown>) => {
  const plain = (typeof (v as IAgentPolicyVersionDocument).toObject === "function" ? (v as IAgentPolicyVersionDocument).toObject() : v) as Record<string, unknown>;
  return {
    ...plain,
    id: String(plain._id),
    changes: diffPolicies((plain.previous as PolicySnapshot | null) ?? null, (plain.snapshot as PolicySnapshot | null) ?? null),
  };
};

export async function listVersions(policyId: string, workspaceIds: Types.ObjectId[]) {
  const versions = await AgentPolicyVersionModel.find({ policyId, workspaceId: { $in: workspaceIds } })
    .sort({ version: -1 })
    .limit(100)
    .populate("changedBy", "name email")
    .populate("reviewedBy", "name email")
    .lean();
  return versions.map((v) => serializeVersion(v));
}

/** Restores an applied version as a new version (also brings back a deleted policy). */
export async function rollback(policyId: string, version: number, workspaceIds: Types.ObjectId[], userId: string) {
  const target = await AgentPolicyVersionModel.findOne({ policyId, version, workspaceId: { $in: workspaceIds }, status: "applied" });
  if (!target) throw new AppError(404, "Version not found", "NOT_FOUND");
  if (!target.snapshot) throw new AppError(400, "That version deleted the policy; pick an earlier one.", "BAD_REQUEST");
  const current = await AgentPolicyModel.findOne({ _id: policyId, workspaceId: target.workspaceId });
  const previous = current ? snapshotOf(current) : null;
  const snapshot = target.snapshot as unknown as PolicySnapshot;
  const policy = await applySnapshot(target.workspaceId, policyId, snapshot, userId);
  const recorded = await recordVersion({
    workspaceId: target.workspaceId,
    policyId,
    action: "rolled_back",
    status: "applied",
    snapshot,
    previous,
    userId,
    note: `Rolled back to version ${version}`,
  });
  await logGovernanceEvent({
    workspaceId: String(target.workspaceId),
    type: "policy_rolled_back",
    actor: "person",
    userId,
    title: `Rolled back policy "${snapshot.name}" to version ${version}`,
    detail: diffPolicies(previous, snapshot).map((c) => c.field).join(", "),
  });
  return { policy, version: recorded };
}

/* ------------------------------------------------------------------ */
/* Simulation: replay recent activity against a proposed policy set     */
/* ------------------------------------------------------------------ */

export interface SimulateInput {
  workspaceId: string;
  /** A new or edited policy (evaluated as enforced). */
  draft?: PolicySnapshot | null;
  /** The policy the draft replaces, or the one to remove. */
  policyId?: string | null;
  remove?: boolean;
  days?: number;
}

export async function simulate(input: SimulateInput) {
  const days = Math.min(30, Math.max(1, Math.round(Number(input.days) || 7)));
  const since = new Date(Date.now() - days * 86_400_000);
  const live = await loadPolicies(input.workspaceId);
  let draftPolicy: PolicyLike | null = null;
  if (input.draft) {
    draftPolicy = {
      id: input.policyId ?? "draft",
      name: input.draft.name || "Draft policy",
      effect: input.draft.effect as PolicyLike["effect"],
      // A draft shows what enforcing it would do.
      mode: "enforce",
      priority: input.draft.priority,
      enabled: true,
      match: input.draft.match as PolicyLike["match"],
    };
  } else if (input.policyId && !input.remove) {
    // An existing policy (e.g. a simulation-only draft), as if enforced.
    const stored = await AgentPolicyModel.findOne({ _id: input.policyId, workspaceId: input.workspaceId }).lean();
    if (!stored) throw new AppError(404, "Policy not found", "NOT_FOUND");
    draftPolicy = {
      id: String(stored._id),
      name: stored.name,
      effect: stored.effect,
      mode: "enforce",
      priority: stored.priority,
      enabled: true,
      match: { ...stored.match, agentIds: stored.match?.agentIds?.map(String), projectIds: stored.match?.projectIds?.map(String) },
    };
  }
  const current = live;
  const proposed = [...live.filter((p) => p.id !== input.policyId), ...(draftPolicy ? [draftPolicy] : [])];

  const rows = await AgentActivityModel.find({ workspaceId: input.workspaceId, createdAt: { $gte: since } })
    .select("agentId action domain risk projectId createdAt classification")
    .sort({ createdAt: -1 })
    .limit(10_000)
    .lean();
  const agents = await AgentModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.agentId)))] } })
    .select("name kind operatedBy")
    .lean();
  const agentById = new Map(agents.map((a) => [String(a._id), a]));
  const results: Array<{ before: Effect; after: Effect; row: (typeof rows)[number]; policy: string | null }> = [];
  for (const row of rows) {
    const agent = agentById.get(String(row.agentId));
    const context = {
      agentId: String(row.agentId),
      agentKind: (agent?.kind ?? "api_key") as never,
      operatedBy: (agent?.operatedBy ?? "internal") as "internal" | "vendor",
      action: row.action,
      domain: row.domain,
      risk: row.risk,
      projectId: row.projectId ? String(row.projectId) : null,
      classification: (row as { classification?: string | null }).classification ?? null,
      now: row.createdAt,
    };
    const before = evaluatePolicies(current, context);
    const after = evaluatePolicies(proposed, context);
    results.push({ before: before.effect, after: after.effect, row, policy: after.policy?.name ?? null });
  }
  const summary = summarizeSimulation(results);
  const samples = results
    .filter((r) => r.before !== r.after)
    .slice(0, 12)
    .map((r) => ({
      at: r.row.createdAt,
      agentId: String(r.row.agentId),
      agentName: agentById.get(String(r.row.agentId))?.name ?? "Agent",
      action: r.row.action,
      risk: r.row.risk,
      before: r.before,
      after: r.after,
      policy: r.policy,
    }));
  return {
    days,
    since,
    capped: rows.length >= 10_000,
    ...summary,
    samples,
    note: "Replays logged agent changes and blocks against policies only. Default risk rules, DLP and safety nets also apply live.",
  };
}
