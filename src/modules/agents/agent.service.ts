import { createHash, randomBytes } from "crypto";
import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import { AppError } from "../../utils/app-error.js";
import DeviceSessionModel from "../auth/models/device-session.model.js";
import UserModel, { type IUserDocument } from "../auth/models/user.model.js";
import {
  DEFAULT_MCP_SCOPES,
  type McpScope,
} from "../mcp/registry/tool-types.js";
import { findMembershipsByUser } from "../workspace/repositories/workspace-member.repository.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { raiseAlert } from "./activity.service.js";
import { detectionFingerprint, type Detection } from "./detection.js";
import { AgentModel, type AgentKind, type IAgentDocument } from "./model.js";

export const ALL_AGENT_SCOPES: McpScope[] = [
  "work:read",
  "work:write",
  "collaboration:read",
  "collaboration:write",
  "analytics:read",
  "ai:execute",
  "prompt:read",
  "prompt:write",
  "workspace:admin",
];

/** Everything except workspace administration. */
export const STANDARD_AGENT_SCOPES: McpScope[] = ALL_AGENT_SCOPES.filter(
  (scope) => scope !== "workspace:admin",
);

const KEY_PREFIX = "pk_agent_";
const CACHE_TTL_MS = 10_000;

export const hashKey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

export const generateAgentKey = (): string =>
  `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;

export const displayPrefix = (raw: string): string =>
  raw.startsWith(KEY_PREFIX)
    ? `${raw.slice(0, KEY_PREFIX.length + 4)}…`
    : `${raw.slice(0, 6)}…`;

export const sanitizeScopes = (
  scopes: unknown,
  fallback: McpScope[],
): McpScope[] => {
  if (!Array.isArray(scopes)) return fallback;
  const valid = scopes.filter((scope): scope is McpScope =>
    ALL_AGENT_SCOPES.includes(scope as McpScope),
  );
  // Read access to work is the floor for any useful agent.
  return Array.from(new Set<McpScope>(["work:read", ...valid]));
};

export interface ResolvedAgent {
  agent: IAgentDocument;
  user: IUserDocument;
}

export type AgentRejection = "expired" | "suspended" | "revoked";

export class AgentAccessError extends AppError {
  constructor(
    public readonly reason: AgentRejection,
    agentName: string,
  ) {
    super(
      403,
      reason === "expired"
        ? `Agent "${agentName}" has expired.`
        : `Agent "${agentName}" is ${reason}.`,
      "AGENT_BLOCKED",
    );
    // AppError resets the prototype; restore it so instanceof works.
    Object.setPrototypeOf(this, AgentAccessError.prototype);
  }
}

/** Whether an agent may act right now. */
export function agentBlockReason(
  agent: IAgentDocument,
  now = new Date(),
): AgentRejection | null {
  if (agent.status === "revoked") return "revoked";
  if (agent.status === "suspended") return "suspended";
  if (agent.expiresAt && agent.expiresAt.getTime() <= now.getTime())
    return "expired";
  return null;
}

class AgentService {
  private keyCache = new Map<
    string,
    { value: ResolvedAgent | null; at: number }
  >();
  /** Session and self-registered agents by id or fingerprint. */
  private agentCache = new Map<string, { agent: IAgentDocument; at: number }>();
  /** Short-lived yes/no lookups (admin rights, blocked sessions). */
  private flagCache = new Map<string, { value: boolean; at: number }>();
  /** Detected agents already announced by this process. */
  private announced = new Set<string>();
  private pendingTouches = new Map<string, number>();
  private touchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Forget cached lookups so suspensions take effect immediately in this
   * process; other instances pick them up within CACHE_TTL_MS.
   */
  public invalidate(agentId?: string): void {
    this.flagCache.clear();
    if (!agentId) {
      this.keyCache.clear();
      this.agentCache.clear();
      return;
    }
    for (const [hash, entry] of this.keyCache) {
      if (entry.value?.agent._id.toString() === agentId)
        this.keyCache.delete(hash);
    }
    for (const [key, entry] of this.agentCache) {
      if (entry.agent._id.toString() === agentId) this.agentCache.delete(key);
    }
  }

  private async cachedAgent(
    key: string,
    load: () => Promise<IAgentDocument | null>,
  ): Promise<IAgentDocument | null> {
    const hit = this.agentCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.agent;
    const agent = await load();
    if (agent) this.agentCache.set(key, { agent, at: Date.now() });
    else this.agentCache.delete(key);
    return agent;
  }

  private async cachedFlag(
    key: string,
    load: () => Promise<boolean>,
  ): Promise<boolean> {
    const hit = this.flagCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await load();
    if (this.flagCache.size > 10_000) this.flagCache.clear();
    this.flagCache.set(key, { value, at: Date.now() });
    return value;
  }

  public async getById(agentId: string): Promise<IAgentDocument | null> {
    if (!Types.ObjectId.isValid(agentId)) return null;
    return this.cachedAgent(`id:${agentId}`, () =>
      AgentModel.findById(agentId),
    );
  }

  /** Links a ChatGPT OAuth session to the user's ChatGPT agent. */
  public async linkChatGptSession(
    userId: string,
    sessionId: string,
  ): Promise<IAgentDocument | null> {
    const user = await UserModel.findById(userId);
    if (!user) return null;
    const agent = await this.registerChatGpt(user, sessionId);
    await DeviceSessionModel.updateOne(
      { _id: sessionId },
      { $set: { agentId: agent._id } },
    );
    return agent;
  }

  public async defaultWorkspaceId(userId: string): Promise<string | null> {
    const memberships = await findMembershipsByUser(userId);
    const first = [...memberships].sort(
      (a, b) =>
        new Date(a.createdAt as Date).getTime() -
        new Date(b.createdAt as Date).getTime(),
    )[0];
    return first ? first.workspaceId.toString() : null;
  }

  public async isWorkspaceAdminAnywhere(userId: string): Promise<boolean> {
    return this.cachedFlag(`admin:${userId}`, async () => {
      const memberships = await findMembershipsByUser(userId);
      return memberships.some((m) => m.role === "OWNER" || m.role === "ADMIN");
    });
  }

  /* ---------------------------- API keys ---------------------------- */

  public async createApiKey(input: {
    ownerUserId: string;
    workspaceId?: string | null;
    name: string;
    scopes?: unknown;
    projectIds?: unknown;
    expiresAt?: unknown;
    legacy?: boolean;
  }): Promise<{ agent: IAgentDocument; key: string }> {
    const name = String(input.name ?? "").trim();
    if (!name) throw new AppError(400, "Name is required", "BAD_REQUEST");
    const expiresAt = input.expiresAt
      ? new Date(String(input.expiresAt))
      : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new AppError(400, "expiresAt must be a date", "BAD_REQUEST");
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, "expiresAt must be in the future", "BAD_REQUEST");
    }
    const projectIds = Array.isArray(input.projectIds)
      ? input.projectIds
          .filter((id) => Types.ObjectId.isValid(String(id)))
          .map(String)
      : [];
    const canAdmin = await this.isWorkspaceAdminAnywhere(input.ownerUserId);
    let scopes = sanitizeScopes(input.scopes, STANDARD_AGENT_SCOPES);
    if (!canAdmin)
      scopes = scopes.filter((scope) => scope !== "workspace:admin");

    const key = generateAgentKey();
    const agent = await AgentModel.create({
      workspaceId:
        input.workspaceId ?? (await this.defaultWorkspaceId(input.ownerUserId)),
      ownerUserId: input.ownerUserId,
      kind: "api_key",
      name,
      keyHash: hashKey(key),
      keyPrefix: displayPrefix(key),
      scopes,
      projectIds,
      expiresAt,
      legacy: Boolean(input.legacy),
    });
    return { agent, key };
  }

  /** Issues a new secret for an API-key agent; the old one stops working at once. */
  public async rotateKey(agent: IAgentDocument): Promise<string> {
    if (agent.kind !== "api_key") {
      throw new AppError(400, "Only API keys can be rotated", "BAD_REQUEST");
    }
    const key = generateAgentKey();
    agent.keyHash = hashKey(key);
    agent.keyPrefix = displayPrefix(key);
    await agent.save();
    this.invalidate(agent._id.toString());
    return key;
  }

  /**
   * Creates (or replaces) a user's "Personal API key": the successor of the
   * legacy Sync key, with full access so existing integrations keep working.
   */
  public async regeneratePersonalKey(userId: string): Promise<string> {
    const existing = await AgentModel.findOne({
      ownerUserId: userId,
      kind: "api_key",
      legacy: true,
      status: { $ne: "revoked" },
    });
    await UserModel.updateOne({ _id: userId }, { $set: { syncApiKey: null } });
    if (existing) return this.rotateKey(existing);
    const { key } = await this.createApiKey({
      ownerUserId: userId,
      name: "Personal API key",
      scopes: ALL_AGENT_SCOPES,
      legacy: true,
    });
    return key;
  }

  /**
   * Finds the agent behind a raw API key. Legacy Sync keys still stored in
   * plain text on the user are moved to a hashed agent key on first use.
   * Throws AgentAccessError for suspended, revoked or expired agents.
   */
  public async resolveApiKey(raw: string): Promise<ResolvedAgent | null> {
    const key = raw.trim();
    if (!key) return null;
    const hash = hashKey(key);
    const cached = this.keyCache.get(hash);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      if (cached.value) {
        const reason = agentBlockReason(cached.value.agent);
        if (reason) throw new AgentAccessError(reason, cached.value.agent.name);
      }
      return cached.value;
    }

    let resolved: ResolvedAgent | null = null;
    const agent = await AgentModel.findOne({ keyHash: hash, kind: "api_key" });
    if (agent) {
      const user = await UserModel.findById(agent.ownerUserId);
      resolved = user ? { agent, user } : null;
    } else {
      resolved = await this.migrateLegacyKey(key, hash);
    }

    this.keyCache.set(hash, { value: resolved, at: Date.now() });
    if (resolved) {
      const reason = agentBlockReason(resolved.agent);
      if (reason) throw new AgentAccessError(reason, resolved.agent.name);
    }
    return resolved;
  }

  private async migrateLegacyKey(
    raw: string,
    hash: string,
  ): Promise<ResolvedAgent | null> {
    const user = await UserModel.findOne({ syncApiKey: raw });
    if (!user) return null;
    try {
      const agent = await AgentModel.create({
        workspaceId: await this.defaultWorkspaceId(user._id.toString()),
        ownerUserId: user._id,
        kind: "api_key",
        name: "Personal API key",
        keyHash: hash,
        keyPrefix: displayPrefix(raw),
        scopes: ALL_AGENT_SCOPES,
        projectIds: [],
        legacy: true,
      });
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { syncApiKey: null } },
      );
      logger.info("Moved a legacy Sync key to a hashed agent key", {
        userId: user._id.toString(),
        agentId: agent._id.toString(),
      });
      return { agent, user };
    } catch (error) {
      // Two concurrent first uses: the other request created the agent.
      const agent = await AgentModel.findOne({
        keyHash: hash,
        kind: "api_key",
      });
      if (agent) return { agent, user };
      throw error;
    }
  }

  /* ------------------------- Self-registration ------------------------ */

  private async upsertByFingerprint(input: {
    user: IUserDocument;
    kind: AgentKind;
    fingerprint: string;
    name: string;
    scopes: McpScope[];
    sessionId?: string | null;
    deviceId?: string | null;
    clientName?: string | null;
    userAgent?: string | null;
    detectionSignals?: string[];
  }): Promise<IAgentDocument> {
    const ownerUserId = input.user._id;
    const cacheKey = `fp:${ownerUserId.toString()}:${input.kind}:${input.fingerprint}`;
    const hit = this.agentCache.get(cacheKey);
    if (
      hit &&
      Date.now() - hit.at < CACHE_TTL_MS &&
      (!input.sessionId ||
        String(hit.agent.sessionId ?? "") === input.sessionId)
    ) {
      return hit.agent;
    }
    const agent = await this.findOrCreateByFingerprint(input);
    this.agentCache.set(cacheKey, { agent, at: Date.now() });
    return agent;
  }

  private async findOrCreateByFingerprint(input: {
    user: IUserDocument;
    kind: AgentKind;
    fingerprint: string;
    name: string;
    scopes: McpScope[];
    sessionId?: string | null;
    deviceId?: string | null;
    clientName?: string | null;
    userAgent?: string | null;
    detectionSignals?: string[];
  }): Promise<IAgentDocument> {
    const ownerUserId = input.user._id;
    const existing = await AgentModel.findOne({
      ownerUserId,
      kind: input.kind,
      fingerprint: input.fingerprint,
    });
    if (existing) {
      const updates: Record<string, unknown> = {};
      if (
        input.sessionId &&
        String(existing.sessionId ?? "") !== input.sessionId
      ) {
        updates.sessionId = input.sessionId;
      }
      if (input.userAgent && existing.userAgent !== input.userAgent)
        updates.userAgent = input.userAgent;
      if (Object.keys(updates).length > 0) {
        await AgentModel.updateOne({ _id: existing._id }, { $set: updates });
        Object.assign(existing, updates);
      }
      return existing;
    }
    try {
      return await AgentModel.create({
        workspaceId: await this.defaultWorkspaceId(ownerUserId.toString()),
        ownerUserId,
        kind: input.kind,
        name: input.name,
        fingerprint: input.fingerprint,
        clientName: input.clientName ?? null,
        userAgent: input.userAgent ?? null,
        sessionId: input.sessionId ?? null,
        deviceId: input.deviceId ?? null,
        detectionSignals: input.detectionSignals ?? [],
        scopes: input.scopes,
        projectIds: [],
      });
    } catch (error) {
      const raced = await AgentModel.findOne({
        ownerUserId,
        kind: input.kind,
        fingerprint: input.fingerprint,
      });
      if (raced) return raced;
      throw error;
    }
  }

  /** An MCP client signed in with a normal user session. */
  public async registerMcpClient(
    user: IUserDocument,
    info: {
      clientName?: string | null;
      userAgent?: string | null;
      sessionId?: string | null;
    },
  ): Promise<IAgentDocument> {
    const clientName = (
      info.clientName ||
      clientFamily(info.userAgent) ||
      "MCP client"
    ).slice(0, 80);
    // A suspended client cannot come back under another name: not within the
    // same session, and not at all while an admin's suspension stands.
    const ownerUserId = user._id.toString();
    const blocked = await this.cachedFlag(
      `mcp-blocked:${ownerUserId}:${info.sessionId ?? ""}`,
      async () =>
        Boolean(
          await AgentModel.exists({
            ownerUserId,
            kind: "mcp_client",
            fingerprint: { $ne: clientName.toLowerCase() },
            status: { $ne: "active" },
            $or: [
              { statusSetByAdmin: true },
              ...(info.sessionId ? [{ sessionId: info.sessionId }] : []),
            ],
          }),
        ),
    );
    if (blocked) throw new AgentAccessError("suspended", clientName);
    const canAdmin = await this.isWorkspaceAdminAnywhere(ownerUserId);
    return this.upsertByFingerprint({
      user,
      kind: "mcp_client",
      fingerprint: clientName.toLowerCase(),
      name: clientName,
      clientName,
      userAgent: info.userAgent ?? null,
      sessionId: info.sessionId ?? null,
      scopes: canAdmin ? ALL_AGENT_SCOPES : STANDARD_AGENT_SCOPES,
    });
  }

  /** The ChatGPT custom GPT connected through OAuth. */
  public async registerChatGpt(
    user: IUserDocument,
    sessionId: string,
  ): Promise<IAgentDocument> {
    return this.upsertByFingerprint({
      user,
      kind: "chatgpt",
      fingerprint: "chatgpt",
      name: "ChatGPT Actions",
      clientName: "ChatGPT",
      sessionId,
      scopes: STANDARD_AGENT_SCOPES,
    });
  }

  public async registerCompanion(
    user: IUserDocument,
    deviceId: string,
    deviceName: string,
  ): Promise<IAgentDocument> {
    return this.upsertByFingerprint({
      user,
      kind: "companion",
      fingerprint: `device:${deviceId}`,
      name: deviceName || "Companion device",
      deviceId,
      scopes: STANDARD_AGENT_SCOPES,
    });
  }

  /**
   * A script or automated browser using a person's own login. It acts with
   * the person's access, so it gets the person's scopes; governance then
   * applies to it like to any agent, and the first sighting raises an alert.
   */
  public async registerDetected(
    user: IUserDocument,
    info: Detection & { userAgent?: string | null; sessionId?: string | null },
  ): Promise<IAgentDocument> {
    const ownerUserId = user._id.toString();
    const canAdmin = await this.isWorkspaceAdminAnywhere(ownerUserId);
    const agent = await this.upsertByFingerprint({
      user,
      kind: "detected",
      fingerprint: detectionFingerprint(info.family),
      name: info.family,
      clientName: info.family,
      userAgent: info.userAgent?.slice(0, 300) ?? null,
      sessionId: info.sessionId ?? null,
      scopes: canAdmin ? ALL_AGENT_SCOPES : STANDARD_AGENT_SCOPES,
      detectionSignals: info.signals,
    });
    const agentId = agent._id.toString();
    if (!this.announced.has(agentId)) {
      if (this.announced.size > 10_000) this.announced.clear();
      this.announced.add(agentId);
      await raiseAlert({
        workspaceId: agent.workspaceId?.toString() ?? null,
        agentId,
        type: "unregistered_agent",
        severity: "warning",
        title: `Unregistered agent: ${agent.name}`,
        detail: `${user.name || user.email} is running ${agent.name} with their own login instead of an agent key. Replace it with an agent key or block it.`,
        dedupeKey: `unregistered_agent:${agentId}`,
      })
        // Score it now rather than at the nightly run, so it shows as risky.
        .then(async () => {
          const { recomputeRisk } = await import("./governance.service.js");
          await recomputeRisk(agent);
        })
        .catch((error) =>
          logger.warn("Could not raise unregistered agent alert", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    }
    return agent;
  }

  /** Whether a workspace makes scripts use agent keys instead of logins. */
  public async requiresAgentKeys(
    workspaceId: string | Types.ObjectId | null | undefined,
  ): Promise<boolean> {
    if (!workspaceId) return false;
    const id = workspaceId.toString();
    return this.cachedFlag(`require-keys:${id}`, async () => {
      const workspace = await WorkspaceModel.findById(id)
        .select("settings.requireAgentKeys")
        .lean();
      return Boolean(workspace?.settings?.requireAgentKeys);
    });
  }

  public async findBySession(
    sessionId: string,
  ): Promise<IAgentDocument | null> {
    return AgentModel.findOne({
      sessionId,
      kind: { $in: ["chatgpt", "mcp_client"] },
    });
  }

  /** Batches last-seen and call-count updates instead of writing on every call. */
  public touch(agentId: string): void {
    this.pendingTouches.set(
      agentId,
      (this.pendingTouches.get(agentId) ?? 0) + 1,
    );
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => void this.flushTouches(), 5000);
    this.touchTimer.unref?.();
  }

  public async flushTouches(): Promise<void> {
    this.touchTimer = null;
    const pending = [...this.pendingTouches.entries()];
    this.pendingTouches.clear();
    if (pending.length === 0) return;
    const now = new Date();
    try {
      await AgentModel.bulkWrite(
        pending.map(([id, count]) => ({
          updateOne: {
            filter: { _id: id },
            update: { $set: { lastSeenAt: now }, $inc: { callCount: count } },
          },
        })),
        { ordered: false },
      );
    } catch (error) {
      logger.warn("Could not record agent activity timestamps", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** "Claude-Desktop/1.2 (mac)" -> "Claude-Desktop". */
export function clientFamily(userAgent?: string | null): string | null {
  if (!userAgent) return null;
  const first = userAgent.split(/[\s/]/)[0]?.trim();
  return first ? first.slice(0, 60) : null;
}

export const DEFAULT_READ_SCOPES = DEFAULT_MCP_SCOPES;

export default new AgentService();
