import { createHash, randomBytes } from "node:crypto";

import logger from "../../lib/logger.js";
import { AppError } from "../../utils/app-error.js";
import { toCsv } from "../../utils/csv.js";
import { decrypt, encrypt } from "../../utils/encryption.js";
import UserModel from "../auth/models/user.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import { raiseAlert } from "../agents/activity.service.js";
import { AutomationLinkModel } from "../telemetry/model.js";
import { closeTask, openTask } from "../telemetry/automation.service.js";
import {
  actorFor,
  createUseCase,
  type Actor,
} from "../ai-governance/service.js";
import vendorService from "../vendors/service.js";
import { VendorModel } from "../vendors/model.js";
import { AgentModel } from "../agents/model.js";
import type { VendorCategory } from "../vendors/catalog.js";
import {
  CATALOG_BY_KEY,
  KIND_LABELS,
  TOOL_KINDS,
  matchName,
  slugify,
  type ToolKind,
} from "./catalog.js";
import { scanCode, type CodeFile } from "./code-scan.js";
import {
  ShadowConnectorModel,
  ShadowRequestModel,
  ShadowSettingsModel,
  ShadowSightingModel,
  ShadowTokenModel,
  ShadowToolModel,
  type IShadowSettingsDocument,
  type IShadowToolDocument,
} from "./model.js";
import {
  DEFAULT_ENDPOINTS,
  parseGoogleKey,
  pullAws,
  pullAzure,
  pullGoogle,
  pullMicrosoft,
  type Endpoints,
} from "./connectors.js";
import { scanForDlp } from "../agents/hybrid.js";
import { assessRisk, type ToolStatus } from "./risk.js";
import {
  isBroadGrant,
  parseLogRows,
  resolveTarget,
  type RawSignal,
  type Resolved,
  type Source,
} from "./signals.js";

export { actorFor };
export type { Actor };

const DAY = 86_400_000;
export const STATUSES: ToolStatus[] = [
  "unreviewed",
  "sanctioned",
  "restricted",
  "prohibited",
  "dismissed",
];
const DATA_TYPES = [
  "public",
  "internal",
  "customer",
  "personal",
  "source_code",
  "financial",
  "health",
  "credentials",
];

const bad = (message: string) => new AppError(400, message, "BAD_REQUEST");
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const requireAdmin = (actor: Actor): void => {
  if (!actor.isAdmin)
    throw new AppError(
      403,
      "Only workspace owners and admins can do this",
      "FORBIDDEN",
    );
};

const CATEGORY: Record<ToolKind, VendorCategory> = {
  model_api: "ai_model",
  model_hub: "ai_model",
  local_runtime: "ai_model",
  coding: "developer_tool",
  agent_platform: "automation",
  assistant: "ai_assistant",
  image_video: "ai_assistant",
  meeting: "ai_assistant",
  writing: "ai_assistant",
  search: "ai_assistant",
  unknown: "other",
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function settingsFor(
  workspaceId: string,
): Promise<IShadowSettingsDocument> {
  const found = await ShadowSettingsModel.findOne({ workspaceId });
  if (found) return found;
  try {
    return await ShadowSettingsModel.create({ workspaceId });
  } catch {
    const again = await ShadowSettingsModel.findOne({ workspaceId });
    if (!again)
      throw new AppError(500, "Could not load shadow AI settings", "INTERNAL");
    return again;
  }
}

const settingsView = (s: IShadowSettingsDocument) => ({
  amnestyUntil: s.amnestyUntil,
  amnestyActive: !!s.amnestyUntil && s.amnestyUntil.getTime() > Date.now(),
  coachMessage: s.coachMessage,
  reviewDays: s.reviewDays,
});

export async function getSettings(actor: Actor) {
  return settingsView(await settingsFor(actor.workspaceId));
}

export async function updateSettings(
  actor: Actor,
  body: Record<string, unknown>,
) {
  requireAdmin(actor);
  const s = await settingsFor(actor.workspaceId);
  if ("amnestyUntil" in body) {
    if (body.amnestyUntil === null || body.amnestyUntil === "")
      s.amnestyUntil = null;
    else {
      const d = new Date(String(body.amnestyUntil));
      if (Number.isNaN(d.getTime())) throw bad("amnestyUntil must be a date");
      if (d.getTime() > Date.now() + 366 * DAY)
        throw bad("An amnesty can run for one year at most");
      s.amnestyUntil = d;
    }
  }
  if ("coachMessage" in body) s.coachMessage = str(body.coachMessage, 1000);
  if ("reviewDays" in body) {
    const n = Number(body.reviewDays);
    if (!Number.isInteger(n) || n < 1 || n > 90)
      throw bad("reviewDays must be between 1 and 90");
    s.reviewDays = n;
  }
  await s.save();
  return settingsView(s);
}

// ---------------------------------------------------------------------------
// Recording evidence
// ---------------------------------------------------------------------------

interface Entry {
  resolved: Resolved;
  userKey: string;
  source: Source;
  detail: string;
  at: Date;
  bytesOut: number;
  uploads: number;
  personal: boolean;
  broad: boolean;
  secret: boolean;
  /** Sensitive items seen going in (counts only; the text is never kept). */
  sensitive?: number;
}

async function record(
  workspaceId: string,
  entries: Entry[],
): Promise<{ matched: number; newTools: number; tools: number }> {
  if (!entries.length) return { matched: 0, newTools: 0, tools: 0 };
  const groups = new Map<
    string,
    Entry & { count: number; personalCount: number; first: Date }
  >();
  for (const e of entries) {
    const k = `${e.resolved.toolKey}|${e.userKey}|${e.source}|${e.detail}`;
    const g = groups.get(k);
    if (!g)
      groups.set(k, {
        ...e,
        count: 1,
        personalCount: e.personal ? 1 : 0,
        first: e.at,
      });
    else {
      g.count += 1;
      g.bytesOut += e.bytesOut;
      g.uploads += e.uploads;
      g.personalCount += e.personal ? 1 : 0;
      if (e.at > g.at) g.at = e.at;
      if (e.at < g.first) g.first = e.at;
      g.broad ||= e.broad;
      g.secret ||= e.secret;
      g.sensitive = (g.sensitive ?? 0) + (e.sensitive ?? 0);
    }
  }
  const toolKeys = new Set<string>();
  const existing = new Set(
    (
      await ShadowToolModel.find({
        workspaceId,
        toolKey: {
          $in: [
            ...new Set([...groups.values()].map((g) => g.resolved.toolKey)),
          ],
        },
      })
        .select("toolKey")
        .lean()
    ).map((t) => t.toolKey),
  );
  let newTools = 0;
  for (const g of groups.values()) {
    const r = g.resolved;
    if (!toolKeys.has(r.toolKey)) {
      toolKeys.add(r.toolKey);
      const res = await ShadowToolModel.updateOne(
        { workspaceId, toolKey: r.toolKey },
        {
          $setOnInsert: {
            workspaceId,
            toolKey: r.toolKey,
            name: r.name,
            vendor: r.vendor,
            kind: r.kind,
            catalog: r.catalog,
            status: "unreviewed",
            firstSeenAt: g.first,
            history: [
              {
                at: new Date(),
                by: null,
                byName: "System",
                action: "discovered",
                detail: `Found through ${g.source}`,
              },
            ],
          },
          $max: { lastSeenAt: g.at },
        },
        { upsert: true },
      );
      if (res.upsertedCount > 0 && !existing.has(r.toolKey)) newTools += 1;
    }
    await ShadowSightingModel.updateOne(
      {
        workspaceId,
        toolKey: r.toolKey,
        userKey: g.userKey,
        source: g.source,
        detail: g.detail,
      },
      {
        $inc: {
          count: g.count,
          bytesOut: g.bytesOut,
          uploads: g.uploads,
          personalCount: g.personalCount,
          sensitive: g.sensitive ?? 0,
        },
        $min: { firstAt: g.first },
        $max: { lastAt: g.at },
        $set: { broad: g.broad, ...(g.secret ? { secret: true } : {}) },
        $setOnInsert: {
          workspaceId,
          toolKey: r.toolKey,
          userKey: g.userKey,
          source: g.source,
          detail: g.detail,
        },
      },
      { upsert: true },
    );
    await ShadowToolModel.updateOne(
      { workspaceId, toolKey: r.toolKey },
      { $max: { lastSeenAt: g.at }, $min: { firstSeenAt: g.first } },
    );
  }
  for (const key of toolKeys) await recompute(workspaceId, key);
  return { matched: entries.length, newTools, tools: toolKeys.size };
}

async function vendorApproved(tool: IShadowToolDocument): Promise<boolean> {
  if (!tool.vendorId) return false;
  const v = await VendorModel.findById(tool.vendorId).select("status").lean();
  return v?.status === "approved";
}

/**
 * Scripts and automated browsers acting with a person's login (found by agent
 * detection) are shadow AI too. They join the inventory as one tool, with the
 * people whose logins they use as the evidence.
 */
export async function syncDetectedAgents(workspaceId: string): Promise<number> {
  const agents = await AgentModel.find({
    workspaceId,
    kind: "detected",
    status: "active",
  })
    .select("name ownerUserId updatedAt")
    .lean();
  if (!agents.length) return 0;
  const owners = await UserModel.find({
    _id: { $in: agents.map((a) => a.ownerUserId) },
  })
    .select("email")
    .lean();
  const email = new Map(owners.map((u) => [String(u._id), u.email]));
  const resolved: Resolved = {
    toolKey: "detected_agents",
    name: "Unregistered scripts and automated browsers",
    vendor: "Unknown",
    kind: "agent_platform",
    catalog: false,
    confidence: 0.8,
  };
  await record(
    workspaceId,
    agents.map((a) => ({
      resolved,
      userKey: userKeyOf(email.get(String(a.ownerUserId))),
      source: "agent" as Source,
      detail: `Agent ${a.name}`.slice(0, 300),
      at: toDate((a as { updatedAt?: Date }).updatedAt),
      bytesOut: 0,
      uploads: 0,
      personal: true,
      broad: true,
      secret: false,
    })),
  );
  return agents.length;
}

/** Rebuilds a tool's totals and risk from its sightings. */
export async function recompute(
  workspaceId: string,
  toolKey: string,
): Promise<void> {
  const tool = await ShadowToolModel.findOne({ workspaceId, toolKey });
  if (!tool) return;
  const rows = await ShadowSightingModel.find({ workspaceId, toolKey }).lean();
  const people = new Set(
    rows.filter((r) => r.userKey !== "unknown").map((r) => r.userKey),
  );
  const requests = rows.reduce((s, r) => s + r.count, 0);
  const personal = rows.reduce((s, r) => s + r.personalCount, 0);
  tool.users = people.size;
  tool.sources = [...new Set(rows.map((r) => r.source))];
  tool.bytesOut = rows.reduce((s, r) => s + r.bytesOut, 0);
  tool.uploads = rows.reduce((s, r) => s + r.uploads, 0);
  tool.personalShare = requests ? personal / requests : 0;
  tool.hasSecret = rows.some((r) => r.secret);
  tool.hasBroadGrant = rows.some((r) => r.broad);
  tool.sensitive = rows.reduce((s, r) => s + (r.sensitive ?? 0), 0);
  const last = rows.reduce((m, r) => Math.max(m, r.lastAt.getTime()), 0);
  if (last)
    tool.lastSeenAt = new Date(Math.max(tool.lastSeenAt.getTime(), last));
  const risk = assessRisk({
    kind: tool.kind,
    status: tool.status,
    users: tool.users,
    bytesOut: tool.bytesOut,
    uploads: tool.uploads,
    personalShare: tool.personalShare,
    hasSecret: tool.hasSecret,
    hasBroadGrant: tool.hasBroadGrant,
    sensitive: tool.sensitive,
    sources: tool.sources.length,
    vendorApproved: await vendorApproved(tool),
    recentlyUsed: Date.now() - tool.lastSeenAt.getTime() < 14 * DAY,
  });
  tool.riskScore = risk.score;
  tool.riskLevel = risk.level;
  await tool.save();
}

const toDate = (v: Date | undefined): Date =>
  v && v.getTime() <= Date.now() + DAY ? v : new Date();
const userKeyOf = (v: string | undefined): string =>
  v && v.length ? v.toLowerCase().slice(0, 200) : "unknown";

/** Signals from a source other than code (logs, OAuth grants, cloud inventory, extensions, expenses). */
export async function ingestSignals(
  workspaceId: string,
  source: Source,
  signals: RawSignal[],
  detailPrefix = "",
) {
  const entries: Entry[] = [];
  let ignored = 0;
  for (const s of signals.slice(0, 5000)) {
    const resolved = resolveTarget(source, s.target);
    if (!resolved) {
      ignored += 1;
      continue;
    }
    entries.push({
      resolved,
      userKey: userKeyOf(s.user),
      source,
      detail:
        source === "oauth" || source === "cloud"
          ? `${detailPrefix}${s.detail ?? (s.scopes ?? []).slice(0, 8).join(" ")}`.slice(
              0,
              300,
            )
          : "",
      at: toDate(s.at),
      bytesOut: Math.max(0, Math.min(1e12, Number(s.bytesOut) || 0)),
      uploads: Math.max(0, Math.min(1e6, Number(s.uploads) || 0)),
      personal: !!s.personal,
      broad: isBroadGrant(s.scopes),
      secret: false,
    });
  }
  const done = await record(workspaceId, entries);
  return { received: signals.length, ignored, ...done };
}

export async function importLog(actor: Actor, text: string) {
  requireAdmin(actor);
  if (!text.trim()) throw bad("Paste or upload a log first");
  if (text.length > 3_000_000)
    throw bad("That file is too large. Send up to 3 MB at a time.");
  const { rows, skipped } = parseLogRows(text);
  const result = await ingestSignals(actor.workspaceId, "network", rows);
  return { ...result, unreadable: skipped };
}

const SOURCE_BODY: Source[] = [
  "network",
  "oauth",
  "cloud",
  "extension",
  "expense",
];

export function parseSignalsBody(body: Record<string, unknown>): {
  source: Source;
  signals: RawSignal[];
} {
  const source = String(body.source) as Source;
  if (!SOURCE_BODY.includes(source))
    throw bad(`source must be one of: ${SOURCE_BODY.join(", ")}`);
  if (!Array.isArray(body.signals) || !body.signals.length)
    throw bad("Send a non-empty signals array");
  if (body.signals.length > 5000)
    throw bad("Send up to 5,000 signals at a time");
  const signals: RawSignal[] = [];
  for (const raw of body.signals) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const target = str(r.target ?? r.host ?? r.app ?? r.name, 300);
    if (!target) continue;
    const at = r.at ? new Date(String(r.at)) : undefined;
    signals.push({
      target,
      user: str(r.user ?? r.email, 200) || undefined,
      at: at && !Number.isNaN(at.getTime()) ? at : undefined,
      bytesOut: Number(r.bytesOut) || 0,
      uploads: Number(r.uploads) || 0,
      personal: r.personal === true,
      scopes: Array.isArray(r.scopes)
        ? r.scopes
            .filter((s): s is string => typeof s === "string")
            .slice(0, 30)
        : undefined,
    });
  }
  return { source, signals };
}

export async function scanFiles(
  workspaceId: string,
  files: CodeFile[],
  repo: string,
) {
  const findings = scanCode(files);
  const entries: Entry[] = [];
  const at = new Date();
  const label = repo ? `${repo}:` : "";
  for (const f of findings) {
    if (f.type === "package") {
      entries.push({
        resolved: {
          toolKey: f.tool.key,
          name: f.tool.name,
          vendor: f.tool.vendor,
          kind: f.tool.kind,
          catalog: true,
          confidence: 1,
        },
        userKey: "unknown",
        source: "code",
        detail: `${label}${f.path}:${f.line} ${f.pkg}`.slice(0, 300),
        at,
        bytesOut: 0,
        uploads: 0,
        personal: false,
        broad: false,
        secret: false,
      });
    } else {
      const tool = CATALOG_BY_KEY.get(f.toolKey);
      if (!tool) continue;
      entries.push({
        resolved: {
          toolKey: tool.key,
          name: tool.name,
          vendor: tool.vendor,
          kind: tool.kind,
          catalog: true,
          confidence: 1,
        },
        userKey: "unknown",
        source: "code",
        detail:
          `${label}${f.path}:${f.line} key ${f.preview} #${f.fingerprint}`.slice(
            0,
            300,
          ),
        at,
        bytesOut: 0,
        uploads: 0,
        personal: false,
        broad: false,
        secret: true,
      });
    }
  }
  const done = await record(workspaceId, entries);
  const keys = findings.filter((f) => f.type === "key");
  // One alert per tool, under the same key the hourly check uses, so a key is not announced twice.
  for (const toolKey of new Set(
    keys.map((k) => (k.type === "key" ? k.toolKey : "")),
  )) {
    const tool = CATALOG_BY_KEY.get(toolKey);
    if (!tool) continue;
    await raiseAlert({
      workspaceId,
      type: "shadow_ai_key",
      severity: "critical",
      title: `${tool.name} key found in code`,
      detail:
        "Rotate it and move it to a secret store. A key that was committed stays readable in the repository history.",
      dedupeKey: `shadow_secret:${workspaceId}:${toolKey}`,
    }).catch(() => undefined);
  }
  return {
    files: files.length,
    packages: findings.filter((f) => f.type === "package").length,
    keys: keys.length,
    findings: findings.slice(0, 200).map((f) =>
      f.type === "package"
        ? {
            type: "package" as const,
            path: f.path,
            line: f.line,
            tool: f.tool.name,
            package: f.pkg,
          }
        : {
            type: "key" as const,
            path: f.path,
            line: f.line,
            tool: f.provider,
            preview: f.preview,
          },
    ),
    ...done,
  };
}

export function parseFilesBody(body: Record<string, unknown>): {
  files: CodeFile[];
  repo: string;
} {
  if (!Array.isArray(body.files) || !body.files.length)
    throw bad("Send a non-empty files array of {path, content}");
  if (body.files.length > 400) throw bad("Send up to 400 files at a time");
  const files: CodeFile[] = [];
  let total = 0;
  for (const f of body.files) {
    const r = f as Record<string, unknown>;
    if (typeof r?.path !== "string" || typeof r?.content !== "string") continue;
    total += r.content.length;
    if (total > 8_000_000) throw bad("Send up to 8 MB of files at a time");
    files.push({ path: r.path.slice(0, 300), content: r.content });
  }
  return { files, repo: str(body.repo, 120) };
}

// ---------------------------------------------------------------------------
// Tokens (server-side keys for log forwarders and scanners)
// ---------------------------------------------------------------------------

const hashToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

export async function createToken(actor: Actor, body: Record<string, unknown>) {
  requireAdmin(actor);
  const name = str(body.name, 80);
  if (name.length < 3)
    throw bad("Give the token a name of at least 3 characters");
  const active = await ShadowTokenModel.countDocuments({
    workspaceId: actor.workspaceId,
    revokedAt: null,
  });
  if (active >= 20)
    throw bad("Revoke an unused token first. A workspace can have 20.");
  const raw = `sai_${randomBytes(24).toString("hex")}`;
  const doc = await ShadowTokenModel.create({
    workspaceId: actor.workspaceId,
    name,
    hash: hashToken(raw),
    prefix: raw.slice(0, 8),
    createdBy: actor.userId,
  });
  return {
    id: String(doc._id),
    name,
    prefix: doc.prefix,
    token: raw,
    note: "Copy it now. It is not shown again.",
  };
}

export async function listTokens(actor: Actor) {
  requireAdmin(actor);
  const rows = await ShadowTokenModel.find({ workspaceId: actor.workspaceId })
    .sort({ createdAt: -1 })
    .lean();
  return rows.map((t) => ({
    id: String(t._id),
    name: t.name,
    prefix: t.prefix,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    createdAt: (t as { createdAt?: Date }).createdAt,
  }));
}

export async function revokeToken(actor: Actor, id: string) {
  requireAdmin(actor);
  const res = await ShadowTokenModel.updateOne(
    { _id: id, workspaceId: actor.workspaceId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (!res.matchedCount)
    throw new AppError(404, "Token not found", "NOT_FOUND");
  return { revoked: true };
}

/** The workspace a token belongs to, or null. Only a token made for shadow AI ingestion is accepted here. */
export async function workspaceOfToken(
  raw: string | undefined,
): Promise<string | null> {
  if (!raw || !/^sai_[a-f0-9]{48}$/.test(raw)) return null;
  const doc = await ShadowTokenModel.findOneAndUpdate(
    { hash: hashToken(raw), revokedAt: null },
    { $set: { lastUsedAt: new Date() } },
    { new: true },
  );
  return doc ? doc.workspaceId : null;
}

// ---------------------------------------------------------------------------
// Tools: list, detail, decide
// ---------------------------------------------------------------------------

const toolView = (
  t: IShadowToolDocument | (Record<string, unknown> & { _id: unknown }),
) => {
  const x = t as unknown as IShadowToolDocument;
  return {
    id: String(x._id),
    toolKey: x.toolKey,
    name: x.name,
    vendor: x.vendor,
    kind: x.kind,
    kindLabel: KIND_LABELS[x.kind] ?? x.kind,
    catalog: x.catalog,
    status: x.status,
    decidedByName: x.decidedByName,
    decidedAt: x.decidedAt,
    reason: x.reason,
    conditions: x.conditions,
    alternative: x.alternative,
    useCaseId: x.useCaseId ? String(x.useCaseId) : null,
    vendorId: x.vendorId ? String(x.vendorId) : null,
    firstSeenAt: x.firstSeenAt,
    lastSeenAt: x.lastSeenAt,
    users: x.users,
    sources: x.sources,
    bytesOut: x.bytesOut,
    uploads: x.uploads,
    personalShare: Math.round(x.personalShare * 100) / 100,
    hasSecret: x.hasSecret,
    hasBroadGrant: x.hasBroadGrant,
    sensitive: x.sensitive ?? 0,
    riskScore: x.riskScore,
    riskLevel: x.riskLevel,
    domains: CATALOG_BY_KEY.get(x.toolKey)?.domains ?? [],
  };
};

export async function listTools(
  actor: Actor,
  f: { status?: string; q?: string; kind?: string; source?: string },
) {
  requireAdmin(actor);
  await syncDetectedAgents(actor.workspaceId);
  const filter: Record<string, unknown> = { workspaceId: actor.workspaceId };
  if (f.status && (STATUSES as string[]).includes(f.status))
    filter.status = f.status;
  else filter.status = { $ne: "dismissed" };
  if (f.kind && (TOOL_KINDS as readonly string[]).includes(f.kind))
    filter.kind = f.kind;
  if (f.source) filter.sources = f.source;
  const rows = await ShadowToolModel.find(filter)
    .sort({ riskScore: -1, lastSeenAt: -1 })
    .limit(500);
  const q = f.q?.toLowerCase();
  return rows
    .filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.vendor.toLowerCase().includes(q),
    )
    .map(toolView);
}

async function loadTool(
  actor: Actor,
  id: string,
): Promise<IShadowToolDocument> {
  if (!/^[a-f0-9]{24}$/i.test(id))
    throw new AppError(404, "Tool not found", "NOT_FOUND");
  const tool = await ShadowToolModel.findOne({
    _id: id,
    workspaceId: actor.workspaceId,
  });
  if (!tool) throw new AppError(404, "Tool not found", "NOT_FOUND");
  return tool;
}

export async function getTool(actor: Actor, id: string) {
  requireAdmin(actor);
  const tool = await loadTool(actor, id);
  const sightings = await ShadowSightingModel.find({
    workspaceId: actor.workspaceId,
    toolKey: tool.toolKey,
  })
    .sort({ lastAt: -1 })
    .limit(300)
    .lean();
  const risk = assessRisk({
    kind: tool.kind,
    status: tool.status,
    users: tool.users,
    bytesOut: tool.bytesOut,
    uploads: tool.uploads,
    personalShare: tool.personalShare,
    hasSecret: tool.hasSecret,
    hasBroadGrant: tool.hasBroadGrant,
    sensitive: tool.sensitive,
    sources: tool.sources.length,
    vendorApproved: await vendorApproved(tool),
    recentlyUsed: Date.now() - tool.lastSeenAt.getTime() < 14 * DAY,
  });
  return {
    ...toolView(tool),
    factors: risk.factors,
    history: [...tool.history].reverse(),
    sightings: sightings.map((s) => ({
      user: s.userKey,
      source: s.source,
      count: s.count,
      bytesOut: s.bytesOut,
      uploads: s.uploads,
      personal: s.personalCount > 0,
      detail: s.detail,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      broad: s.broad,
      secret: s.secret,
      sensitive: s.sensitive ?? 0,
    })),
  };
}

export async function decide(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireAdmin(actor);
  const tool = await loadTool(actor, id);
  const status = String(body.status) as ToolStatus;
  if (!STATUSES.includes(status) || status === "unreviewed")
    throw bad("status must be sanctioned, restricted, prohibited or dismissed");
  const reason = str(body.reason, 1000);
  if (reason.length < 10)
    throw bad(
      "Say why in at least 10 characters. The reason is kept in the audit trail.",
    );
  const conditions = str(body.conditions, 1000);
  if (status === "restricted" && conditions.length < 5)
    throw bad("Say what the conditions are for a restricted tool");
  const previous = tool.status;
  tool.status = status;
  tool.reason = reason;
  tool.conditions = status === "restricted" ? conditions : "";
  tool.alternative =
    status === "prohibited" || status === "restricted"
      ? str(body.alternative, 300)
      : "";
  tool.decidedBy = actor.userId;
  tool.decidedByName = actor.name;
  tool.decidedAt = new Date();
  tool.history.push({
    at: new Date(),
    by: actor.userId,
    byName: actor.name,
    action: status,
    detail: `${previous} to ${status}: ${reason}`,
  });

  // An approved tool becomes a vendor to review, and optionally a use case to govern.
  let useCaseId: string | null = null;
  if (status === "sanctioned" || status === "restricted") {
    try {
      const cat = CATALOG_BY_KEY.get(tool.toolKey);
      const { vendor } = await vendorService.ensureVendor(
        actor.workspaceId,
        {
          key: `shadow_${tool.toolKey}`.slice(0, 60),
          name: tool.name,
          category: CATEGORY[tool.kind],
          website: cat?.domains[0] ? `https://${cat.domains[0]}` : "",
          purpose: `${KIND_LABELS[tool.kind]} found through shadow AI discovery`,
        },
        "shadow_ai",
      );
      tool.vendorId = vendor._id as never;
    } catch (error) {
      logger.warn("Could not link a shadow AI tool to a vendor", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (body.registerUseCase === true && !tool.useCaseId) {
      const uc = (await createUseCase(actor, {
        name: `${tool.name} (approved from shadow AI)`.slice(0, 120),
        description:
          `${tool.name} was found in use through discovery and ${status === "restricted" ? "approved with conditions" : "sanctioned"}. ${tool.conditions}`.trim(),
        type: "generative",
        factsheet: {
          modelProvider: tool.vendor,
          modelName: tool.name,
          dataSources: "",
          intendedUse: reason,
        },
      })) as { id?: string; _id?: unknown };
      useCaseId = String(uc.id ?? uc._id ?? "");
      if (/^[a-f0-9]{24}$/i.test(useCaseId))
        tool.useCaseId = useCaseId as never;
      tool.history.push({
        at: new Date(),
        by: actor.userId,
        byName: actor.name,
        action: "registered",
        detail: "Created a draft use case",
      });
    }
  }
  await tool.save();
  await recompute(actor.workspaceId, tool.toolKey);
  await closeReviewTask(tool, `${actor.name} marked it ${status}.`);
  // Open requests for this tool follow the decision.
  if (status !== "dismissed") {
    await ShadowRequestModel.updateMany(
      {
        workspaceId: actor.workspaceId,
        toolKey: tool.toolKey,
        status: "pending",
      },
      {
        $set: {
          status: status === "prohibited" ? "rejected" : "approved",
          decidedBy: actor.userId,
          decidedByName: actor.name,
          decidedAt: new Date(),
          decisionNote: `Tool marked ${status}: ${reason}`.slice(0, 500),
        },
      },
    );
  }
  const fresh = await loadTool(actor, id);
  return {
    ...toolView(fresh),
    useCaseId: fresh.useCaseId ? String(fresh.useCaseId) : useCaseId,
  };
}

/** Puts a decided tool back in the queue, e.g. after the vendor changed its terms. */
export async function reopen(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireAdmin(actor);
  const tool = await loadTool(actor, id);
  const reason = str(body.reason, 500) || "Re-opened for review";
  tool.status = "unreviewed";
  tool.history.push({
    at: new Date(),
    by: actor.userId,
    byName: actor.name,
    action: "reopened",
    detail: reason,
  });
  await tool.save();
  await recompute(actor.workspaceId, tool.toolKey);
  return toolView(await loadTool(actor, id));
}

// ---------------------------------------------------------------------------
// People: declare a tool, ask for one
// ---------------------------------------------------------------------------

export async function declare(actor: Actor, body: Record<string, unknown>) {
  const name = str(body.toolName, 120);
  if (name.length < 2) throw bad("Tell us which tool it is");
  const kind = body.kind === "request" ? "request" : "declared";
  const purpose = str(body.purpose, 1000);
  if (purpose.length < 10)
    throw bad("Say what you use it for, in at least 10 characters");
  const dataTypes = Array.isArray(body.dataTypes)
    ? body.dataTypes
        .filter(
          (d): d is string => typeof d === "string" && DATA_TYPES.includes(d),
        )
        .slice(0, 8)
    : [];
  const catalogTool = matchName(name);
  const resolved: Resolved = catalogTool
    ? {
        toolKey: catalogTool.key,
        name: catalogTool.name,
        vendor: catalogTool.vendor,
        kind: catalogTool.kind,
        catalog: true,
        confidence: 1,
      }
    : {
        toolKey: `app_${slugify(name)}`,
        name,
        vendor: name,
        kind: "unknown",
        catalog: false,
        confidence: 0.5,
      };
  if (!resolved.toolKey || resolved.toolKey === "app_")
    throw bad("That is not a usable tool name");
  const dup = await ShadowRequestModel.findOne({
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    toolKey: resolved.toolKey,
    status: "pending",
  });
  if (dup) throw bad("You already have an open note about this tool");
  const user = await UserModel.findById(actor.userId).select("email").lean();
  const settings = await settingsFor(actor.workspaceId);
  const amnesty =
    !!settings.amnestyUntil && settings.amnestyUntil.getTime() > Date.now();
  await record(actor.workspaceId, [
    {
      resolved,
      userKey: userKeyOf(user?.email ?? actor.userId),
      source: "declared",
      detail: kind,
      at: new Date(),
      bytesOut: 0,
      uploads: 0,
      personal: false,
      broad: false,
      secret: false,
    },
  ]);
  const doc = await ShadowRequestModel.create({
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    userName: actor.name,
    toolKey: resolved.toolKey,
    toolName: resolved.name,
    kind,
    purpose,
    dataTypes,
    amnesty: kind === "declared" && amnesty,
  });
  const tool = await ShadowToolModel.findOne({
    workspaceId: actor.workspaceId,
    toolKey: resolved.toolKey,
  });
  // Coach, don't just block: say where the tool stands and what to use instead.
  return {
    id: String(doc._id),
    status: doc.status,
    amnesty: doc.amnesty,
    tool: tool
      ? {
          name: tool.name,
          status: tool.status,
          conditions: tool.conditions,
          alternative: tool.alternative,
          reason:
            tool.status === "prohibited" || tool.status === "restricted"
              ? tool.reason
              : "",
        }
      : null,
    message: settings.coachMessage,
  };
}

export async function listRequests(actor: Actor, status?: string) {
  const filter: Record<string, unknown> = { workspaceId: actor.workspaceId };
  if (!actor.isAdmin) filter.userId = actor.userId;
  if (
    status &&
    ["pending", "approved", "rejected", "withdrawn"].includes(status)
  )
    filter.status = status;
  const rows = await ShadowRequestModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const tools = await ShadowToolModel.find({
    workspaceId: actor.workspaceId,
    toolKey: { $in: rows.map((r) => r.toolKey) },
  }).lean();
  const byKey = new Map(tools.map((t) => [t.toolKey, t]));
  return rows.map((r) => {
    const t = byKey.get(r.toolKey);
    return {
      id: String(r._id),
      userName: r.userName,
      isMine: r.userId === actor.userId,
      toolKey: r.toolKey,
      toolName: r.toolName,
      toolId: t ? String(t._id) : null,
      toolStatus: t?.status ?? "unreviewed",
      kind: r.kind,
      purpose: r.purpose,
      dataTypes: r.dataTypes,
      status: r.status,
      amnesty: r.amnesty,
      decidedByName: r.decidedByName,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      createdAt: (r as { createdAt?: Date }).createdAt,
    };
  });
}

export async function decideRequest(
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requireAdmin(actor);
  if (!/^[a-f0-9]{24}$/i.test(id))
    throw new AppError(404, "Request not found", "NOT_FOUND");
  const req = await ShadowRequestModel.findOne({
    _id: id,
    workspaceId: actor.workspaceId,
  });
  if (!req) throw new AppError(404, "Request not found", "NOT_FOUND");
  if (req.status !== "pending") throw bad("This request is already decided");
  const decision =
    body.decision === "approved"
      ? "approved"
      : body.decision === "rejected"
        ? "rejected"
        : null;
  if (!decision) throw bad("decision must be approved or rejected");
  const note = str(body.note, 500);
  if (note.length < 5) throw bad("Add a short note so the person knows why");
  req.status = decision;
  req.decidedBy = actor.userId;
  req.decidedByName = actor.name;
  req.decidedAt = new Date();
  req.decisionNote = note;
  await req.save();
  return { id: String(req._id), status: req.status };
}

export async function withdrawRequest(actor: Actor, id: string) {
  if (!/^[a-f0-9]{24}$/i.test(id))
    throw new AppError(404, "Request not found", "NOT_FOUND");
  const req = await ShadowRequestModel.findOne({
    _id: id,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    status: "pending",
  });
  if (!req) throw new AppError(404, "Request not found", "NOT_FOUND");
  req.status = "withdrawn";
  await req.save();
  return { id: String(req._id), status: req.status };
}

/** Plain tool names for the "which tool?" picker. Names and kinds only. */
export function pickerOptions() {
  return [...CATALOG_BY_KEY.values()]
    .map((t) => ({ key: t.key, name: t.name, vendor: t.vendor, kind: t.kind }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export async function overview(actor: Actor) {
  requireAdmin(actor);
  await syncDetectedAgents(actor.workspaceId);
  const [tools, sightings, openRequests, settings] = await Promise.all([
    ShadowToolModel.find({
      workspaceId: actor.workspaceId,
      status: { $ne: "dismissed" },
    }).lean(),
    ShadowSightingModel.find({ workspaceId: actor.workspaceId })
      .select("toolKey userKey source")
      .lean(),
    ShadowRequestModel.countDocuments({
      workspaceId: actor.workspaceId,
      status: "pending",
    }),
    settingsFor(actor.workspaceId),
  ]);
  const byStatus: Record<string, number> = {
    unreviewed: 0,
    sanctioned: 0,
    restricted: 0,
    prohibited: 0,
  };
  for (const t of tools) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const statusOf = new Map(tools.map((t) => [t.toolKey, t.status]));
  const exposed = new Set<string>();
  const coverage: Record<string, number> = {};
  for (const s of sightings) {
    coverage[s.source] = (coverage[s.source] ?? 0) + 1;
    const st = statusOf.get(s.toolKey);
    if (st && st !== "sanctioned" && s.userKey !== "unknown")
      exposed.add(s.userKey);
  }
  const decided = tools.filter((t) => t.decidedAt);
  const mean = (xs: number[]) =>
    xs.length
      ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length / DAY) * 10) / 10
      : null;
  const now = Date.now();
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = now - (7 - i) * 7 * DAY;
    const start = end - 7 * DAY;
    return {
      weekEnding: new Date(end).toISOString().slice(0, 10),
      found: tools.filter(
        (t) =>
          t.firstSeenAt.getTime() > start && t.firstSeenAt.getTime() <= end,
      ).length,
    };
  });
  const byKind: Record<string, number> = {};
  for (const t of tools) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  return {
    totals: {
      tools: tools.length,
      unreviewed: byStatus.unreviewed,
      unreviewedShare: tools.length
        ? Math.round((byStatus.unreviewed / tools.length) * 100)
        : 0,
      peopleOnUnsanctioned: exposed.size,
      prohibitedInUse: tools.filter(
        (t) =>
          t.status === "prohibited" && now - t.lastSeenAt.getTime() < 14 * DAY,
      ).length,
      keysInCode: tools.filter((t) => t.hasSecret).length,
      openRequests,
    },
    byStatus,
    byKind,
    coverage,
    meanDaysToDecision: mean(
      decided.map(
        (t) => (t.decidedAt as Date).getTime() - t.firstSeenAt.getTime(),
      ),
    ),
    oldestUnreviewedDays: tools
      .filter((t) => t.status === "unreviewed")
      .reduce(
        (m, t) =>
          Math.max(m, Math.floor((now - t.firstSeenAt.getTime()) / DAY)),
        0,
      ),
    newPerWeek: weeks,
    topRisks: tools
      .filter((t) => t.status !== "sanctioned")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 5)
      .map((t) => toolView(t as never)),
    settings: settingsView(settings),
    sourcesConnected: Object.keys(coverage),
  };
}

// ---------------------------------------------------------------------------
// Policy export
// ---------------------------------------------------------------------------

export async function policy(actor: Actor, format: string) {
  requireAdmin(actor);
  const tools = await ShadowToolModel.find({
    workspaceId: actor.workspaceId,
    status: { $in: ["sanctioned", "restricted", "prohibited"] },
  })
    .sort({ name: 1 })
    .lean();
  const domains = (key: string) => CATALOG_BY_KEY.get(key)?.domains ?? [];
  if (format === "blocklist") {
    const hosts = [
      ...new Set(
        tools
          .filter((t) => t.status === "prohibited")
          .flatMap((t) => domains(t.toolKey)),
      ),
    ].sort();
    return {
      type: "text/plain",
      name: "shadow-ai-blocklist.txt",
      body: hosts.join("\n") + (hosts.length ? "\n" : ""),
    };
  }
  if (format === "csv") {
    return {
      type: "text/csv",
      name: "shadow-ai-policy.csv",
      body: toCsv(
        [
          "tool",
          "vendor",
          "kind",
          "status",
          "conditions",
          "alternative",
          "decided_by",
          "decided_at",
          "reason",
          "domains",
        ],
        tools.map((t) => [
          t.name,
          t.vendor,
          t.kind,
          t.status,
          t.conditions,
          t.alternative,
          t.decidedByName,
          t.decidedAt?.toISOString() ?? "",
          t.reason,
          domains(t.toolKey).join(" "),
        ]),
      ),
    };
  }
  const pick = (s: string) =>
    tools
      .filter((t) => t.status === s)
      .map((t) => ({
        name: t.name,
        vendor: t.vendor,
        kind: t.kind,
        domains: domains(t.toolKey),
        conditions: t.conditions,
        alternative: t.alternative,
        reason: t.reason,
        decidedBy: t.decidedByName,
        decidedAt: t.decidedAt,
      }));
  return {
    type: "application/json",
    name: "shadow-ai-policy.json",
    body: JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sanctioned: pick("sanctioned"),
        restricted: pick("restricted"),
        prohibited: pick("prohibited"),
      },
      null,
      2,
    ),
  };
}

// ---------------------------------------------------------------------------
// Monitoring (hourly) and compliance facts
// ---------------------------------------------------------------------------

const reviewKey = (toolId: string) => `shadow_review:${toolId}`;

async function closeReviewTask(
  tool: IShadowToolDocument,
  reason: string,
): Promise<void> {
  try {
    const link = await AutomationLinkModel.findOne({
      key: reviewKey(String(tool._id)),
      state: "open",
    });
    if (link) await closeTask(link, reason);
  } catch (error) {
    logger.warn("Could not close a shadow AI review task", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function firstAdmin(workspaceId: string): Promise<string | null> {
  const owner = await WorkspaceMemberModel.findOne({
    workspaceId,
    role: "OWNER",
  })
    .select("userId")
    .lean();
  const admin =
    owner ??
    (await WorkspaceMemberModel.findOne({ workspaceId, role: "ADMIN" })
      .select("userId")
      .lean());
  return admin ? String(admin.userId) : null;
}

const weekOf = (d: Date): string =>
  `${d.getUTCFullYear()}-${Math.floor(d.getTime() / (7 * DAY))}`;

export async function monitorWorkspace(
  workspaceId: string,
): Promise<{ alerts: number; tasks: number }> {
  const settings = await settingsFor(workspaceId);
  const tools = await ShadowToolModel.find({
    workspaceId,
    status: { $nin: ["dismissed", "sanctioned"] },
  });
  const now = new Date();
  let alerts = 0;
  let tasks = 0;
  const assignee = await firstAdmin(workspaceId);
  for (const t of tools) {
    await syncDetectedAgents(workspaceId);
    if (
      t.status === "prohibited" &&
      now.getTime() - t.lastSeenAt.getTime() < 7 * DAY
    ) {
      const raised = await raiseAlert({
        workspaceId,
        type: "shadow_ai_prohibited",
        severity: "critical",
        title: `${t.name} is prohibited but still in use`,
        detail:
          `${t.users} ${t.users === 1 ? "person" : "people"}, last seen ${t.lastSeenAt.toISOString().slice(0, 10)}. ${t.alternative ? `Offer: ${t.alternative}.` : ""}`.trim(),
        dedupeKey: `shadow_prohibited:${t._id}:${weekOf(now)}`,
      }).catch(() => false);
      if (raised) alerts += 1;
    }
    if (t.hasSecret && t.status !== "restricted") {
      const raised = await raiseAlert({
        workspaceId,
        type: "shadow_ai_key",
        severity: "critical",
        title: `${t.name} key found in code`,
        detail: "Rotate it and move it to a secret store.",
        dedupeKey: `shadow_secret:${workspaceId}:${t.toolKey}`,
      }).catch(() => false);
      if (raised) alerts += 1;
    }
    const ageDays = (now.getTime() - t.firstSeenAt.getTime()) / DAY;
    if (
      t.status === "unreviewed" &&
      ageDays >= settings.reviewDays &&
      assignee &&
      tasks < 5
    ) {
      try {
        const link = await openTask(
          {
            rule: "shadow_ai",
            key: reviewKey(String(t._id)),
            title: `Review AI tool: ${t.name}`,
            description: `${t.name} has been in use for ${Math.floor(ageDays)} days without a decision. ${t.users} ${t.users === 1 ? "person uses" : "people use"} it (risk ${t.riskLevel}). Decide whether to sanction, restrict or prohibit it.`,
            priority:
              t.riskLevel === "critical"
                ? "CRITICAL"
                : t.riskLevel === "high"
                  ? "HIGH"
                  : "MEDIUM",
            assigneeUserId: assignee,
            link: "/ai-governance/shadow-ai",
          },
          workspaceId,
          { enabled: true, projectId: null } as never,
        );
        if (link) tasks += 1;
      } catch (error) {
        logger.warn("Could not open a shadow AI review task", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { alerts, tasks };
}

export async function monitorAll(): Promise<{
  workspaces: number;
  alerts: number;
  tasks: number;
  connectors: { connectors: number; failed: number };
}> {
  const connectors = await syncAllConnectors().catch(() => ({
    connectors: 0,
    failed: 0,
  }));
  const ids = [
    ...new Set([
      ...((await ShadowToolModel.distinct("workspaceId")) as string[]),
      ...(
        await AgentModel.distinct("workspaceId", {
          kind: "detected",
          status: "active",
        })
      ).map(String),
    ]),
  ];
  let alerts = 0;
  let tasks = 0;
  for (const id of ids) {
    try {
      const r = await monitorWorkspace(id);
      alerts += r.alerts;
      tasks += r.tasks;
    } catch (error) {
      logger.warn("Shadow AI monitoring failed for a workspace", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { workspaces: ids.length, alerts, tasks, connectors };
}

/** Facts for the compliance report. `known` is false until anything has been discovered, so the report says "not assessed" rather than "pass". */
export async function complianceFacts(workspaceId: string) {
  const tools = await ShadowToolModel.find({
    workspaceId,
    status: { $ne: "dismissed" },
  })
    .select("status firstSeenAt lastSeenAt hasSecret")
    .lean();
  const settings = await ShadowSettingsModel.findOne({ workspaceId }).lean();
  const reviewDays = settings?.reviewDays ?? 14;
  const now = Date.now();
  return {
    known: tools.length > 0,
    tools: tools.length,
    overdue: tools.filter(
      (t) =>
        t.status === "unreviewed" &&
        now - t.firstSeenAt.getTime() > reviewDays * DAY,
    ).length,
    unreviewed: tools.filter((t) => t.status === "unreviewed").length,
    prohibitedInUse: tools.filter(
      (t) =>
        t.status === "prohibited" && now - t.lastSeenAt.getTime() < 14 * DAY,
    ).length,
    keysInCode: tools.filter((t) => t.hasSecret).length,
  };
}

/** Runs the hourly check for this workspace now (admins), so the result can be seen without waiting. */
export async function runMonitor(actor: Actor) {
  requireAdmin(actor);
  for (const c of await ShadowConnectorModel.find({
    workspaceId: actor.workspaceId,
  }))
    await syncConnector(c);
  return monitorWorkspace(actor.workspaceId);
}

// ---------------------------------------------------------------------------
// Connectors: Google Workspace and Microsoft Entra
// ---------------------------------------------------------------------------

/** Where the connectors call. Tests point these at a stub; production uses the real services. */
let endpoints: Endpoints = DEFAULT_ENDPOINTS;
export const useEndpoints = (e: Endpoints | null): void => {
  endpoints = e ?? DEFAULT_ENDPOINTS;
};

const CONNECTOR_TYPES = [
  "google_workspace",
  "microsoft_entra",
  "azure_ai",
  "aws_ai",
] as const;
const CLOUD_TYPES: string[] = ["azure_ai", "aws_ai"];
const TYPE_LABEL: Record<string, string> = {
  google_workspace: "Google Workspace",
  microsoft_entra: "Microsoft Entra",
  azure_ai: "Azure AI",
  aws_ai: "AWS AI",
};
type ConnectorType = (typeof CONNECTOR_TYPES)[number];

const connectorView = (c: IShadowConnectorDocumentLike) => ({
  id: String(c._id),
  type: c.type,
  name: c.name,
  account: c.account,
  lastSyncAt: c.lastSyncAt,
  lastStatus: c.lastStatus,
  lastError: c.lastError,
  lastUsers: c.lastUsers,
  lastSignals: c.lastSignals,
  lastTruncated: c.lastTruncated,
});
type IShadowConnectorDocumentLike = Awaited<
  ReturnType<typeof ShadowConnectorModel.findOne>
> &
  object;

type Creds = Record<string, string>;

async function pull(type: ConnectorType, creds: Creds) {
  if (type === "azure_ai")
    return pullAzure(
      {
        tenantId: creds.tenantId,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        subscriptionId: creds.subscriptionId,
      },
      endpoints,
    );
  if (type === "aws_ai")
    return pullAws(
      {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        regions: creds.regions,
      },
      endpoints,
    );
  return type === "google_workspace"
    ? pullGoogle(
        {
          serviceAccountEmail: creds.serviceAccountEmail,
          privateKey: creds.privateKey,
          adminEmail: creds.adminEmail,
        },
        endpoints,
      )
    : pullMicrosoft(
        {
          tenantId: creds.tenantId,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        },
        endpoints,
      );
}

/** Replaces what this connector reported last time, so a revoked grant disappears. */
async function applyPull(
  workspaceId: string,
  type: ConnectorType,
  result: Awaited<ReturnType<typeof pull>>,
) {
  const prefix = `${type}: `;
  const source = CLOUD_TYPES.includes(type) ? "cloud" : "oauth";
  const old = await ShadowSightingModel.find({
    workspaceId,
    source,
    detail: { $regex: `^${type}: ` },
  })
    .select("toolKey")
    .lean();
  await ShadowSightingModel.deleteMany({
    workspaceId,
    source,
    detail: { $regex: `^${type}: ` },
  });
  const done = await ingestSignals(workspaceId, source, result.signals, prefix);
  const fresh = new Set<string>();
  for (const o of old) fresh.add(o.toolKey);
  for (const key of fresh) await recompute(workspaceId, key);
  return done;
}

export async function syncConnector(
  doc: NonNullable<IShadowConnectorDocumentLike>,
) {
  try {
    const creds = JSON.parse(decrypt(doc.credentials)) as Creds;
    const result = await pull(doc.type as ConnectorType, creds);
    await applyPull(doc.workspaceId, doc.type as ConnectorType, result);
    doc.lastStatus = "ok";
    doc.lastError = "";
    doc.lastUsers = result.users;
    doc.lastSignals = result.signals.length;
    doc.lastTruncated = result.truncated;
  } catch (error) {
    doc.lastStatus = "error";
    doc.lastError = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 300);
  }
  doc.lastSyncAt = new Date();
  await doc.save();
  return connectorView(doc);
}

export async function addConnector(
  actor: Actor,
  body: Record<string, unknown>,
) {
  requireAdmin(actor);
  const type = String(body.type) as ConnectorType;
  if (!CONNECTOR_TYPES.includes(type))
    throw bad(`type must be one of: ${CONNECTOR_TYPES.join(", ")}`);
  const name = str(body.name, 80) || TYPE_LABEL[type];
  if (
    (await ShadowConnectorModel.countDocuments({
      workspaceId: actor.workspaceId,
    })) >= 5
  )
    throw bad("A workspace can have 5 connectors");
  let creds: Creds;
  let account: string;
  if (type === "google_workspace") {
    const adminEmail = str(body.adminEmail, 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail))
      throw bad(
        "Give the email of a Workspace admin the service account can act as",
      );
    let key;
    try {
      key = parseGoogleKey(String(body.serviceAccountKey ?? ""));
    } catch (e) {
      throw bad((e as Error).message);
    }
    creds = {
      serviceAccountEmail: key.serviceAccountEmail,
      privateKey: key.privateKey,
      adminEmail,
    };
    account = adminEmail;
  } else if (type === "aws_ai") {
    const accessKeyId = str(body.accessKeyId, 128);
    const secretAccessKey = str(body.secretAccessKey, 200);
    const regions = str(body.regions, 200);
    if (!accessKeyId || secretAccessKey.length < 20 || !regions)
      throw bad(
        "Access key ID, secret access key and at least one region are needed",
      );
    creds = { accessKeyId, secretAccessKey, regions };
    account = `${accessKeyId.slice(0, 8)}… (${regions})`;
  } else {
    const tenantId = str(body.tenantId, 120);
    const clientId = str(body.clientId, 120);
    const clientSecret = str(body.clientSecret, 300);
    if (!tenantId || !clientId || clientSecret.length < 8)
      throw bad("Tenant ID, client ID and client secret are all needed");
    creds = { tenantId, clientId, clientSecret };
    account = tenantId;
    if (type === "azure_ai") {
      const subscriptionId = str(body.subscriptionId, 60);
      if (!subscriptionId) throw bad("The subscription ID is needed");
      creds.subscriptionId = subscriptionId;
      account = `${tenantId} / ${subscriptionId}`;
    }
  }
  // Try it before saving, so a wrong key is caught now and not at the first hourly sync.
  let result;
  try {
    result = await pull(type, creds);
  } catch (error) {
    throw bad(
      `Could not connect: ${(error instanceof Error ? error.message : String(error)).slice(0, 250)}`,
    );
  }
  const doc = await ShadowConnectorModel.create({
    workspaceId: actor.workspaceId,
    type,
    name,
    credentials: encrypt(JSON.stringify(creds)),
    account,
    createdBy: actor.userId,
  });
  await applyPull(actor.workspaceId, type, result);
  doc.lastStatus = "ok";
  doc.lastSyncAt = new Date();
  doc.lastUsers = result.users;
  doc.lastSignals = result.signals.length;
  doc.lastTruncated = result.truncated;
  await doc.save();
  return connectorView(doc);
}

export async function listConnectors(actor: Actor) {
  requireAdmin(actor);
  return (
    await ShadowConnectorModel.find({ workspaceId: actor.workspaceId }).sort({
      createdAt: 1,
    })
  ).map((c) => connectorView(c));
}

export async function syncNow(actor: Actor, id: string) {
  requireAdmin(actor);
  const doc = /^[a-f0-9]{24}$/i.test(id)
    ? await ShadowConnectorModel.findOne({
        _id: id,
        workspaceId: actor.workspaceId,
      })
    : null;
  if (!doc) throw new AppError(404, "Connector not found", "NOT_FOUND");
  return syncConnector(doc);
}

export async function removeConnector(actor: Actor, id: string) {
  requireAdmin(actor);
  const doc = /^[a-f0-9]{24}$/i.test(id)
    ? await ShadowConnectorModel.findOne({
        _id: id,
        workspaceId: actor.workspaceId,
      })
    : null;
  if (!doc) throw new AppError(404, "Connector not found", "NOT_FOUND");
  await doc.deleteOne();
  // What it reported stays as history until the next sync of another source; the tools keep their decisions.
  return { removed: true };
}

export async function syncAllConnectors(): Promise<{
  connectors: number;
  failed: number;
}> {
  const docs = await ShadowConnectorModel.find({});
  let failed = 0;
  for (const d of docs) {
    const v = await syncConnector(d);
    if (v.lastStatus === "error") failed += 1;
  }
  return { connectors: docs.length, failed };
}

// ---------------------------------------------------------------------------
// Enforcement hooks for gateways and browser extensions (token-authenticated)
// ---------------------------------------------------------------------------

/** "May this person use this host?" Also records the use, so a gateway that asks is also a source. */
export async function checkHost(
  workspaceId: string,
  hostOrUrl: string,
  user?: string,
) {
  const resolved = resolveTarget("network", hostOrUrl);
  if (!resolved)
    return { known: false, allowed: true, status: null, message: "" };
  await record(workspaceId, [
    {
      resolved,
      userKey: userKeyOf(user),
      source: "network",
      detail: "",
      at: new Date(),
      bytesOut: 0,
      uploads: 0,
      personal: false,
      broad: false,
      secret: false,
    },
  ]);
  const tool = await ShadowToolModel.findOne({
    workspaceId,
    toolKey: resolved.toolKey,
  }).lean();
  const settings = await settingsFor(workspaceId);
  const status = (tool?.status ?? "unreviewed") as ToolStatus;
  return {
    known: true,
    tool: resolved.name,
    status,
    allowed: status !== "prohibited",
    conditions: status === "restricted" ? (tool?.conditions ?? "") : "",
    alternative: tool?.alternative ?? "",
    reason:
      status === "prohibited" || status === "restricted"
        ? (tool?.reason ?? "")
        : "",
    message: settings.coachMessage,
  };
}

export async function blocklistFor(workspaceId: string): Promise<string> {
  const tools = await ShadowToolModel.find({
    workspaceId,
    status: "prohibited",
  })
    .select("toolKey")
    .lean();
  const hosts = [
    ...new Set(
      tools.flatMap((t) => CATALOG_BY_KEY.get(t.toolKey)?.domains ?? []),
    ),
  ].sort();
  return hosts.join("\n") + (hosts.length ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Sensitive data going into AI tools (browser extension)
// ---------------------------------------------------------------------------

const DLP_KINDS = new Set([
  "credential",
  "card_number",
  "national_id",
  "email",
  "phone",
]);
const DLP_SERIOUS = new Set(["credential", "card_number", "national_id"]);

/**
 * The browser extension sends what a person is about to paste or submit into
 * an AI site. It is checked in memory and thrown away: only the kinds and
 * counts are kept. The answer says whether to let it through, warn, or block.
 */
export async function inspectText(
  workspaceId: string,
  hostOrUrl: string,
  user: string | undefined,
  text: string,
) {
  const resolved = resolveTarget("network", hostOrUrl);
  if (!resolved)
    return {
      known: false,
      action: "allow" as const,
      findings: [] as Array<{ type: string; label: string; count: number }>,
    };
  const findings = scanForDlp(text.slice(0, 100_000))
    .filter((f) => DLP_KINDS.has(f.type))
    .map((f) => ({ type: f.type, label: f.label, count: f.count }));
  const total = findings.reduce((n, f) => n + f.count, 0);
  const tool = await ShadowToolModel.findOne({
    workspaceId,
    toolKey: resolved.toolKey,
  }).lean();
  const status = (tool?.status ?? "unreviewed") as ToolStatus;
  if (total > 0) {
    await record(workspaceId, [
      {
        resolved,
        userKey: userKeyOf(user),
        source: "extension",
        detail: "sensitive data",
        at: new Date(),
        bytesOut: Math.min(text.length, 1e7),
        uploads: 0,
        personal: false,
        broad: false,
        secret: false,
        sensitive: total,
      },
    ]);
    if (status !== "sanctioned") {
      const serious = findings.some((f) => DLP_SERIOUS.has(f.type));
      await raiseAlert({
        workspaceId,
        type: "shadow_ai_sensitive",
        severity: serious ? "critical" : "warning",
        title: `Sensitive data sent to ${resolved.name}`,
        detail: `${findings.map((f) => `${f.count} ${f.label.toLowerCase()}`).join(", ")}. The tool is ${STATUS_LABELS_PLAIN[status]}.`,
        dedupeKey: `shadow_dlp:${workspaceId}:${resolved.toolKey}:${new Date().toISOString().slice(0, 10)}`,
      }).catch(() => undefined);
    }
  }
  const serious = findings.some((f) => DLP_SERIOUS.has(f.type));
  const action =
    total === 0
      ? "allow"
      : status === "prohibited" || (serious && status !== "sanctioned")
        ? "block"
        : "warn";
  const settings = await settingsFor(workspaceId);
  return {
    known: true,
    tool: resolved.name,
    status,
    action,
    findings,
    alternative: tool?.alternative ?? "",
    message: settings.coachMessage,
  };
}

const STATUS_LABELS_PLAIN: Record<ToolStatus, string> = {
  unreviewed: "not yet reviewed",
  sanctioned: "sanctioned",
  restricted: "restricted",
  prohibited: "prohibited",
  dismissed: "ignored",
};
