import { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import vendorService from "../vendors/service.js";
import agentService from "./agent.service.js";
import { invalidateMaskingSetting } from "./ai-governance.js";
import { AgentPolicyVersionModel } from "./advanced.model.js";
import { scheduleComplianceCheck } from "./compliance.service.js";
import { invalidatePolicies } from "./guard.js";
import { normalizeGovernance, type GovernanceSettings } from "./hybrid.js";
import {
  invalidateGovernanceSettings,
  logGovernanceEvent,
} from "./hybrid.service.js";
import { AgentPolicyModel, type IAgentPolicyDocument } from "./model.js";
import { recordVersion, snapshotOf } from "./policy-versions.service.js";
import {
  REGULATION_PACKS,
  isEmptySettings,
  missingSettings,
  packById,
  type PackItem,
  type PackSettings,
  type RegulationPack,
} from "./regulation-packs.js";

export type PackStart = "recommended" | "advisory";

interface CurrentSettings {
  governance: GovernanceSettings;
  aiDataMasking: boolean;
  approvedVendorsOnly: boolean;
  requireAgentKeys: boolean;
}

async function currentSettings(
  workspaceId: Types.ObjectId | string,
): Promise<CurrentSettings> {
  const ws = await WorkspaceModel.findById(workspaceId)
    .select("settings")
    .lean();
  const s = (ws?.settings ?? {}) as Record<string, unknown>;
  return {
    governance: normalizeGovernance(s.governance),
    aiDataMasking: Boolean(s.aiDataMasking),
    approvedVendorsOnly: Boolean(s.approvedVendorsOnly),
    requireAgentKeys: Boolean(s.requireAgentKeys),
  };
}

const packPolicies = (workspaceId: Types.ObjectId | string, packId?: string) =>
  AgentPolicyModel.find({
    workspaceId,
    ...(packId ? { "pack.id": packId } : { pack: { $ne: null } }),
  });

/** Pending proposals (change approval on) that would install a pack item. */
async function proposedItems(
  workspaceId: Types.ObjectId | string,
): Promise<Set<string>> {
  const rows = await AgentPolicyVersionModel.find({
    workspaceId,
    status: "proposed",
    "snapshot.pack": { $ne: null },
  })
    .select("snapshot")
    .lean();
  const out = new Set<string>();
  for (const row of rows) {
    const pack = (
      row.snapshot as { pack?: { id?: string; item?: string } } | null
    )?.pack;
    if (pack?.id && pack.item) out.add(`${pack.id}:${pack.item}`);
  }
  return out;
}

export type ItemStatus =
  | "installed"
  | "proposed"
  | "not_installed"
  | "met"
  | "not_met"
  | "built_in"
  | "manual";

/** Every pack with how far this workspace has applied it. */
export async function listPacks(workspaceId: Types.ObjectId | string) {
  const [settings, policies, proposed] = await Promise.all([
    currentSettings(workspaceId),
    packPolicies(workspaceId),
    proposedItems(workspaceId),
  ]);
  const byItem = new Map<string, IAgentPolicyDocument>();
  for (const p of policies)
    if (p.pack) byItem.set(`${p.pack.id}:${p.pack.item}`, p);
  return REGULATION_PACKS.map((pack) => {
    const items = pack.items.map((item) => {
      let status: ItemStatus;
      let policy: { id: string; mode: string; enabled: boolean } | null = null;
      let missing: PackSettings | null = null;
      if (item.kind === "policy") {
        const p = byItem.get(`${pack.id}:${item.id}`);
        if (p)
          policy = { id: p._id.toString(), mode: p.mode, enabled: p.enabled };
        status = p
          ? "installed"
          : proposed.has(`${pack.id}:${item.id}`)
            ? "proposed"
            : "not_installed";
      } else if (item.kind === "setting") {
        missing = missingSettings(item.settings, settings);
        status = isEmptySettings(missing) ? "met" : "not_met";
      } else {
        status = item.kind;
      }
      return { ...item, status, policy, missing };
    });
    const actionable = items.filter(
      (i) => (i.kind === "policy" || i.kind === "setting") && !i.optional,
    );
    const done = actionable.filter(
      (i) => i.status === "installed" || i.status === "met",
    ).length;
    return {
      ...pack,
      items,
      applied: items.some(
        (i) =>
          i.kind === "policy" &&
          (i.status === "installed" || i.status === "proposed"),
      ),
      progress: { done, total: actionable.length },
    };
  });
}

/** Turns settings on; never turns anything off. Returns the setting names changed. */
async function tightenSettings(
  workspaceId: Types.ObjectId,
  userId: string,
  wanted: PackSettings,
  label: string,
): Promise<string[]> {
  const current = await currentSettings(workspaceId);
  const change = missingSettings(wanted, current);
  if (isEmptySettings(change)) return [];
  const $set: Record<string, unknown> = {};
  const changed: string[] = [];
  if (change.governance) {
    $set["settings.governance"] = normalizeGovernance({
      ...current.governance,
      ...change.governance,
    });
    changed.push(...Object.keys(change.governance));
  }
  for (const key of [
    "aiDataMasking",
    "approvedVendorsOnly",
    "requireAgentKeys",
  ] as const) {
    if (change[key]) {
      $set[`settings.${key}`] = true;
      changed.push(key);
    }
  }
  await WorkspaceModel.updateOne({ _id: workspaceId }, { $set });
  const id = workspaceId.toString();
  invalidateGovernanceSettings(id);
  if (change.aiDataMasking) invalidateMaskingSetting(id);
  if (change.approvedVendorsOnly) vendorService.invalidate();
  if (change.requireAgentKeys) agentService.invalidate();
  await logGovernanceEvent({
    workspaceId: id,
    type: "settings_changed",
    actor: "person",
    userId,
    title: `Governance settings changed by the ${label} pack`,
    detail: changed.join(", "),
  });
  return changed;
}

/** Installs or updates one pack policy. With change approval on, it becomes a proposal. */
async function installPolicy(
  workspaceId: Types.ObjectId,
  userId: string,
  pack: RegulationPack,
  item: PackItem,
  start: PackStart,
  changeApproval: boolean,
): Promise<"created" | "updated" | "unchanged" | "proposed"> {
  const spec = item.policy;
  if (!spec) return "unchanged";
  const data = {
    name: spec.name,
    description: spec.description,
    effect: spec.effect,
    mode: start === "advisory" ? "advisory" : spec.mode,
    priority: spec.priority,
    enabled: true,
    match: spec.match,
    pack: { id: pack.id, item: item.id },
  };
  const existing = await AgentPolicyModel.findOne({
    workspaceId,
    "pack.id": pack.id,
    "pack.item": item.id,
  });
  const snapshot = snapshotOf(data);
  if (existing) {
    const previous = snapshotOf(existing);
    if (
      JSON.stringify({ ...previous, pack: null }) ===
      JSON.stringify({ ...snapshot, pack: null })
    )
      return "unchanged";
    if (changeApproval) {
      await recordVersion({
        workspaceId,
        policyId: existing._id,
        action: "updated",
        status: "proposed",
        snapshot,
        previous,
        userId,
        note: `${pack.name} pack`,
      });
      return "proposed";
    }
    existing.set({ ...data, updatedBy: userId });
    await existing.save();
    await recordVersion({
      workspaceId,
      policyId: existing._id,
      action: "updated",
      status: "applied",
      snapshot,
      previous,
      userId,
      note: `${pack.name} pack`,
    });
    return "updated";
  }
  if (changeApproval) {
    const already = await proposedItems(workspaceId);
    if (already.has(`${pack.id}:${item.id}`)) return "unchanged";
    await recordVersion({
      workspaceId,
      policyId: new Types.ObjectId(),
      action: "created",
      status: "proposed",
      snapshot,
      previous: null,
      userId,
      note: `${pack.name} pack`,
    });
    return "proposed";
  }
  const policy = await AgentPolicyModel.create({
    ...data,
    workspaceId,
    createdBy: userId,
    updatedBy: userId,
  });
  await recordVersion({
    workspaceId,
    policyId: policy._id,
    action: "created",
    status: "applied",
    snapshot: snapshotOf(policy),
    previous: null,
    userId,
    note: `${pack.name} pack`,
  });
  return "created";
}

export interface ApplyResult {
  policies: {
    created: number;
    updated: number;
    unchanged: number;
    proposed: number;
  };
  settingsChanged: string[];
  /** Obligations Pristine cannot meet: the organisation's to-do list. */
  manual: string[];
}

/** Applies a whole pack (or one item of it). Settings are only ever tightened. */
export async function applyPack(input: {
  workspaceId: Types.ObjectId;
  userId: string;
  packId: string;
  start?: PackStart;
  itemId?: string;
}): Promise<ApplyResult> {
  const pack = packById(input.packId);
  if (!pack) throw new AppError(404, "Unknown regulation pack", "NOT_FOUND");
  const start: PackStart =
    input.start === "advisory" ? "advisory" : "recommended";
  const items = input.itemId
    ? pack.items.filter((i) => i.id === input.itemId)
    : pack.items.filter((i) => !i.optional);
  if (input.itemId && !items.length)
    throw new AppError(404, "Unknown pack item", "NOT_FOUND");

  // Settings first: the policies below rely on them (e.g. data labels, DLP).
  const wanted: PackSettings = {};
  for (const item of items) {
    if (item.kind !== "setting") continue;
    const s =
      start === "advisory"
        ? (item.advisorySettings ?? null)
        : (item.settings ?? null);
    if (!s) continue;
    wanted.governance = {
      ...(wanted.governance ?? {}),
      ...(s.governance ?? {}),
    };
    for (const key of [
      "aiDataMasking",
      "approvedVendorsOnly",
      "requireAgentKeys",
    ] as const)
      if (s[key]) wanted[key] = true;
  }
  // "dlpMode" from several items: keep the strictest.
  const settingsChanged = await tightenSettings(
    input.workspaceId,
    input.userId,
    wanted,
    pack.name,
  );

  const changeApproval = (await currentSettings(input.workspaceId)).governance
    .policyChangeApproval;
  const counts = { created: 0, updated: 0, unchanged: 0, proposed: 0 };
  for (const item of items) {
    if (item.kind !== "policy") continue;
    counts[
      await installPolicy(
        input.workspaceId,
        input.userId,
        pack,
        item,
        start,
        changeApproval,
      )
    ] += 1;
  }
  const id = input.workspaceId.toString();
  if (counts.created || counts.updated) invalidatePolicies(id);
  scheduleComplianceCheck(id, "policy change");
  await logGovernanceEvent({
    workspaceId: id,
    type: "regulation_pack_applied",
    actor: "person",
    userId: input.userId,
    title: input.itemId
      ? `Applied "${items[0].title}" from the ${pack.name} pack`
      : `Applied the ${pack.name} pack${start === "advisory" ? " in advisory" : ""}`,
    detail:
      [
        counts.created ? `${counts.created} policy(ies) added` : null,
        counts.updated ? `${counts.updated} updated` : null,
        counts.proposed
          ? `${counts.proposed} proposed for a second admin`
          : null,
        settingsChanged.length
          ? `settings: ${settingsChanged.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("; ") || "already applied",
  });
  return {
    policies: counts,
    settingsChanged,
    manual: items.filter((i) => i.kind === "manual").map((i) => i.title),
  };
}

/** Removes the policies a pack installed. Settings stay as they are. */
export async function removePack(input: {
  workspaceId: Types.ObjectId;
  userId: string;
  packId: string;
}): Promise<{ removed: number; proposed: number }> {
  const pack = packById(input.packId);
  if (!pack) throw new AppError(404, "Unknown regulation pack", "NOT_FOUND");
  const changeApproval = (await currentSettings(input.workspaceId)).governance
    .policyChangeApproval;
  const policies = await packPolicies(input.workspaceId, pack.id);
  let removed = 0;
  let proposed = 0;
  for (const policy of policies) {
    if (changeApproval) {
      await recordVersion({
        workspaceId: input.workspaceId,
        policyId: policy._id,
        action: "deleted",
        status: "proposed",
        snapshot: null,
        previous: snapshotOf(policy),
        userId: input.userId,
        note: `Remove ${pack.name} pack`,
      });
      proposed += 1;
      continue;
    }
    await recordVersion({
      workspaceId: input.workspaceId,
      policyId: policy._id,
      action: "deleted",
      status: "applied",
      snapshot: null,
      previous: snapshotOf(policy),
      userId: input.userId,
      note: `Remove ${pack.name} pack`,
    });
    await AgentPolicyVersionModel.updateMany(
      { policyId: policy._id, status: "proposed" },
      { $set: { status: "withdrawn", reviewedAt: new Date() } },
    );
    await policy.deleteOne();
    removed += 1;
  }
  const id = input.workspaceId.toString();
  if (removed) invalidatePolicies(id);
  scheduleComplianceCheck(id, "policy change");
  await logGovernanceEvent({
    workspaceId: id,
    type: "regulation_pack_removed",
    actor: "person",
    userId: input.userId,
    title: `Removed the ${pack.name} pack`,
    detail: proposed
      ? `${proposed} removal(s) proposed for a second admin`
      : `${removed} policy(ies) removed; settings left as they are`,
  });
  return { removed, proposed };
}
