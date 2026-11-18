import crypto from "crypto";
import { Types } from "mongoose";

import UserModel, { type IUserDocument } from "../auth/models/user.model.js";
import DeviceSessionModel from "../auth/models/device-session.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import ProjectModel from "../project/models/project.model.js";
import ProjectMemberModel from "../project/models/project-member.model.js";
import TaskModel from "../task/models/task.model.js";
import InvitationModel from "../workspace/models/invitation.model.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import AdminAuditModel from "./admin-audit.model.js";
import { isEnvSuperAdmin, isSuperAdmin } from "./super-admin.js";

export class AdminError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oid = (v: string, label = "id"): Types.ObjectId => {
  if (!Types.ObjectId.isValid(v))
    throw new AdminError(404, `${label} not found`);
  return new Types.ObjectId(v);
};
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Actor {
  id: string;
  email: string;
  ip?: string | null;
}

/** A password that satisfies the sign-up rules, shown once to the admin who set it. */
export const generateTemporaryPassword = (): string =>
  `${crypto.randomBytes(9).toString("base64url")}aA1!`;

class AdminUsersService {
  public async record(
    actor: Actor,
    action: string,
    target: {
      type: "user" | "workspace" | "platform";
      id?: string;
      label?: string;
    },
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await AdminAuditModel.create({
      actorId: oid(actor.id),
      actorEmail: actor.email,
      action,
      targetType: target.type,
      targetId: target.id ?? null,
      targetLabel: target.label ?? null,
      details,
      ip: actor.ip ?? null,
    });
  }

  private status(u: {
    accountStatus?: string | null;
  }): "active" | "suspended" | "deleted" {
    return (u.accountStatus as "active" | "suspended" | "deleted") ?? "active";
  }

  private row(
    u: IUserDocument & { _id: Types.ObjectId },
    extra: {
      workspaces?: number;
      projects?: number;
      lastActiveAt?: Date | null;
    } = {},
  ) {
    return {
      id: String(u._id),
      email: u.email,
      name: u.name ?? null,
      authProvider: u.authProvider,
      status: this.status(u),
      isSuperAdmin: isSuperAdmin(u),
      superAdminSource: isEnvSuperAdmin(u.email)
        ? "settings"
        : u.platformRole === "super_admin"
          ? "database"
          : null,
      twoFactorEnabled: Boolean(u.twoFactorEnabled),
      suspendedAt: u.suspendedAt ?? null,
      suspendedReason: u.suspendedReason ?? null,
      createdAt: u.createdAt ?? null,
      workspaces: extra.workspaces ?? 0,
      projects: extra.projects ?? 0,
      lastActiveAt: extra.lastActiveAt ?? null,
    };
  }

  public async list(query: {
    q?: string;
    status?: string;
    role?: string;
    provider?: string;
    sort?: string;
    order?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const filter: Record<string, unknown> = {};
    const q = query.q?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ email: rx }, { name: rx }];
    }
    if (query.status === "active")
      filter.accountStatus = { $nin: ["suspended", "deleted"] };
    else if (query.status === "suspended" || query.status === "deleted")
      filter.accountStatus = query.status;
    if (query.role === "super_admin") {
      const listed = (process.env.SUPER_ADMIN_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const or = [
        { platformRole: "super_admin" },
        ...(listed.length ? [{ email: { $in: listed } }] : []),
      ];
      filter.$and = [...((filter.$and as unknown[]) ?? []), { $or: or }];
    }
    if (query.provider === "local" || query.provider === "google")
      filter.authProvider = query.provider;
    const sortKey = ["createdAt", "email", "name"].includes(query.sort ?? "")
      ? (query.sort as string)
      : "createdAt";
    const dir = query.order === "asc" ? 1 : -1;

    const [total, users] = await Promise.all([
      UserModel.countDocuments(filter),
      UserModel.find(filter)
        .select(
          "-password -twoFactorCode -passwordResetCode -syncApiKey -openaiApiKey -anthropicApiKey -geminiApiKey",
        )
        .sort({ [sortKey]: dir, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    const ids = users.map((u) => u._id);
    const [wm, pm, sessions] = await Promise.all([
      WorkspaceMemberModel.aggregate([
        { $match: { userId: { $in: ids } } },
        { $group: { _id: "$userId", n: { $sum: 1 } } },
      ]),
      ProjectMemberModel.aggregate([
        { $match: { userId: { $in: ids } } },
        { $group: { _id: "$userId", n: { $sum: 1 } } },
      ]),
      DeviceSessionModel.find({ userId: { $in: ids } })
        .select("userId lastUsedAt")
        .lean(),
    ]);
    const count = (rows: Array<{ _id: Types.ObjectId; n?: number }>) =>
      new Map(rows.map((r) => [String(r._id), r.n ?? 0]));
    const w = count(wm);
    const p = count(pm);
    const last = new Map<string, Date | null>();
    for (const sess of sessions) {
      const k = String(sess.userId);
      const at = sess.lastUsedAt ?? null;
      if (at && (!last.get(k) || at > (last.get(k) as Date))) last.set(k, at);
    }
    return {
      users: users.map((u) =>
        this.row(u, {
          workspaces: w.get(String(u._id)),
          projects: p.get(String(u._id)),
          lastActiveAt: last.get(String(u._id)) ?? null,
        }),
      ),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  public async detail(userId: string) {
    const id = oid(userId, "User");
    const user = await UserModel.findById(id)
      .select(
        "-password -twoFactorCode -passwordResetCode -syncApiKey -openaiApiKey -anthropicApiKey -geminiApiKey",
      )
      .exec();
    if (!user) throw new AdminError(404, "User not found");
    const aiErrors = await PromptExecutionLogModel.countDocuments({
      userId: id,
      status: "error",
    });
    const [
      wmem,
      pmem,
      sessions,
      tasksCreated,
      tasksAssigned,
      ai,
      invites,
      audit,
    ] = await Promise.all([
      WorkspaceMemberModel.find({ userId: id }).lean(),
      ProjectMemberModel.find({ userId: id }).lean(),
      DeviceSessionModel.find({ userId: id })
        .sort({ lastUsedAt: -1 })
        .limit(20)
        .lean(),
      TaskModel.countDocuments({ userId: id }),
      TaskModel.countDocuments({ assignedTo: id }),
      PromptExecutionLogModel.aggregate([
        { $match: { userId: id } },
        {
          $group: {
            _id: null,
            runs: { $sum: 1 },
            tokens: { $sum: "$totalTokens" },
            cost: { $sum: "$totalCost" },
          },
        },
      ]),
      InvitationModel.countDocuments({ invitedBy: id }),
      AdminAuditModel.find({ targetType: "user", targetId: userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);
    const [workspaces, projects] = await Promise.all([
      WorkspaceModel.find({ _id: { $in: wmem.map((m) => m.workspaceId) } })
        .select("name")
        .lean(),
      ProjectModel.find({ _id: { $in: pmem.map((m) => m.projectId) } })
        .select("name")
        .lean(),
    ]);
    const wname = new Map(workspaces.map((w) => [String(w._id), w.name]));
    const pname = new Map(projects.map((p) => [String(p._id), p.name]));
    const now = Date.now();
    const last = sessions.reduce<Date | null>(
      (a, s) => (s.lastUsedAt && (!a || s.lastUsedAt > a) ? s.lastUsedAt : a),
      null,
    );
    return {
      ...this.row(user, {
        workspaces: wmem.length,
        projects: pmem.length,
        lastActiveAt: last,
      }),
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      passwordChangedAt: user.passwordChangedAt ?? null,
      memberships: {
        workspaces: wmem.map((m) => ({
          id: String(m.workspaceId),
          name: wname.get(String(m.workspaceId)) ?? "Deleted workspace",
          role: m.role,
        })),
        projects: pmem.map((m) => ({
          id: String(m.projectId),
          name: pname.get(String(m.projectId)) ?? "Deleted project",
          role: m.role,
        })),
      },
      sessions: sessions.map((s) => ({
        id: String(s._id),
        deviceType: s.deviceType,
        deviceName: s.deviceName ?? null,
        userAgent: s.userAgent ?? null,
        createdAt: (s as { createdAt?: Date }).createdAt ?? null,
        lastUsedAt: s.lastUsedAt ?? null,
        expiresAt: s.expiresAt,
        active: !s.revokedAt && new Date(s.expiresAt).getTime() > now,
      })),
      stats: {
        tasksCreated,
        tasksAssigned,
        invitationsSent: invites,
        aiRuns: ai[0]?.runs ?? 0,
        aiTokens: ai[0]?.tokens ?? 0,
        aiCost: Math.round((ai[0]?.cost ?? 0) * 10000) / 10000,
        aiErrors,
      },
      audit: audit.map((a) => ({
        id: String(a._id),
        action: a.action,
        actorEmail: a.actorEmail,
        details: a.details ?? {},
        createdAt: a.createdAt,
      })),
    };
  }

  private async load(userId: string): Promise<IUserDocument> {
    const user = await UserModel.findById(oid(userId, "User")).exec();
    if (!user) throw new AdminError(404, "User not found");
    return user;
  }

  private async otherActiveSuperAdmins(excludeId: string): Promise<number> {
    const listed = (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    return UserModel.countDocuments({
      _id: { $ne: oid(excludeId) },
      accountStatus: { $nin: ["suspended", "deleted"] },
      $or: [
        { platformRole: "super_admin" },
        ...(listed.length ? [{ email: { $in: listed } }] : []),
      ],
    });
  }

  private async guardTarget(
    actor: Actor,
    user: IUserDocument,
    verb: string,
  ): Promise<void> {
    if (String(user._id) === actor.id)
      throw new AdminError(409, `You cannot ${verb} your own account.`);
    if (
      isSuperAdmin(user) &&
      (await this.otherActiveSuperAdmins(String(user._id))) === 0
    )
      throw new AdminError(
        409,
        `That is the last super admin, so it cannot be ${verb}d.`,
      );
  }

  public async revokeSessions(userId: string): Promise<number> {
    const r = await DeviceSessionModel.updateMany(
      { userId: oid(userId), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return r.modifiedCount ?? 0;
  }

  public async create(
    actor: Actor,
    body: {
      email?: unknown;
      name?: unknown;
      password?: unknown;
    },
  ) {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email))
      throw new AdminError(400, "Enter a valid email address.");
    if (await UserModel.exists({ email }))
      throw new AdminError(409, "An account with that email already exists.");
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 120)
        : null;
    const given =
      typeof body.password === "string" && body.password.length > 0
        ? body.password
        : null;
    if (given && given.length < 8)
      throw new AdminError(400, "A password needs at least 8 characters.");
    const password = given ?? generateTemporaryPassword();
    const parts = (name ?? "").split(/\s+/).filter(Boolean);
    const user = await UserModel.create({
      email,
      password,
      name,
      firstName: parts[0] ?? null,
      lastName: parts.slice(1).join(" ") || null,
      authProvider: "local",
      // Nobody is made a super admin from the panel: super admins are created with `npm run seed:super-admin`
      // or listed in SUPER_ADMIN_EMAILS on the server.
      platformRole: "user",
    });
    try {
      const ws = (await import("../workspace/services/workspace.service.js"))
        .default;
      await ws.getOrCreateDefaultWorkspace(String(user._id));
    } catch {
      /* the person gets a workspace on first sign-in if this fails */
    }
    await this.record(actor, "user.create", {
      type: "user",
      id: String(user._id),
      label: email,
    });
    return { user: this.row(user), temporaryPassword: given ? null : password };
  }

  public async update(
    actor: Actor,
    userId: string,
    body: { name?: unknown; email?: unknown },
  ) {
    const user = await this.load(userId);
    const before = { name: user.name, email: user.email };
    if (
      typeof body.email === "string" &&
      body.email.trim().toLowerCase() !== user.email
    ) {
      const email = body.email.trim().toLowerCase();
      if (!EMAIL.test(email))
        throw new AdminError(400, "Enter a valid email address.");
      if (await UserModel.exists({ email, _id: { $ne: user._id } }))
        throw new AdminError(409, "Another account already uses that email.");
      user.email = email;
    }
    if (typeof body.name === "string") {
      user.name = body.name.trim().slice(0, 120) || null;
      const parts = (user.name ?? "").split(/\s+/).filter(Boolean);
      user.firstName = parts[0] ?? null;
      user.lastName = parts.slice(1).join(" ") || null;
    }
    await user.save();
    await this.record(
      actor,
      "user.update",
      { type: "user", id: userId, label: user.email },
      { before, after: { name: user.name, email: user.email } },
    );
    return this.row(user);
  }

  public async suspend(actor: Actor, userId: string, reason: unknown) {
    const user = await this.load(userId);
    await this.guardTarget(actor, user, "suspend");
    if (this.status(user) === "deleted")
      throw new AdminError(409, "A deleted account cannot be suspended.");
    user.accountStatus = "suspended";
    user.suspendedAt = new Date();
    user.suspendedReason =
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 300)
        : null;
    await user.save();
    const revoked = await this.revokeSessions(userId);
    await this.record(
      actor,
      "user.suspend",
      { type: "user", id: userId, label: user.email },
      { reason: user.suspendedReason, sessionsRevoked: revoked },
    );
    return this.row(user);
  }

  public async reactivate(actor: Actor, userId: string) {
    const user = await this.load(userId);
    if (this.status(user) === "deleted")
      throw new AdminError(409, "A deleted account cannot be restored.");
    user.accountStatus = "active";
    user.suspendedAt = null;
    user.suspendedReason = null;
    await user.save();
    await this.record(actor, "user.reactivate", {
      type: "user",
      id: userId,
      label: user.email,
    });
    return this.row(user);
  }

  public async resetPassword(actor: Actor, userId: string) {
    const user = await this.load(userId);
    if (this.status(user) === "deleted")
      throw new AdminError(409, "A deleted account has no password.");
    const temporaryPassword = generateTemporaryPassword();
    user.password = temporaryPassword;
    user.authProvider = user.authProvider === "google" ? "google" : "local";
    await user.save();
    const revoked = await this.revokeSessions(userId);
    await this.record(
      actor,
      "user.reset_password",
      { type: "user", id: userId, label: user.email },
      { sessionsRevoked: revoked },
    );
    return { temporaryPassword };
  }

  public async disableTwoFactor(actor: Actor, userId: string) {
    const user = await this.load(userId);
    user.twoFactorEnabled = false;
    user.twoFactorCode = null;
    await user.save();
    await this.record(actor, "user.disable_2fa", {
      type: "user",
      id: userId,
      label: user.email,
    });
    return this.row(user);
  }

  public async signOutEverywhere(actor: Actor, userId: string) {
    const user = await this.load(userId);
    const revoked = await this.revokeSessions(userId);
    await this.record(
      actor,
      "user.revoke_sessions",
      { type: "user", id: userId, label: user.email },
      { sessionsRevoked: revoked },
    );
    return { revoked };
  }

  /**
   * Deleting an account anonymises it: sign-in details, keys and memberships go, but the work the
   * person created stays attached to a "Deleted user", so projects and history stay intact.
   */
  public async remove(actor: Actor, userId: string, confirmEmail: unknown) {
    const user = await this.load(userId);
    if (
      typeof confirmEmail !== "string" ||
      confirmEmail.trim().toLowerCase() !== user.email
    )
      throw new AdminError(400, "Type the person's email to confirm.");
    await this.guardTarget(actor, user, "delete");
    const label = user.email;
    const id = oid(userId);
    // A workspace the person owns that other people also belong to must be handed over first.
    const owned = await WorkspaceModel.find({ ownerId: id })
      .select("_id")
      .lean();
    if (owned.length) {
      const shared = await WorkspaceMemberModel.aggregate([
        {
          $match: {
            workspaceId: { $in: owned.map((w) => w._id) },
            userId: { $ne: id },
          },
        },
        { $group: { _id: "$workspaceId" } },
        { $count: "n" },
      ]);
      if ((shared[0]?.n ?? 0) > 0)
        throw new AdminError(
          409,
          "This person owns a workspace that other people belong to. Hand it over first.",
        );
    }
    await Promise.all([
      WorkspaceMemberModel.deleteMany({ userId: id }),
      ProjectMemberModel.deleteMany({ userId: id }),
      InvitationModel.deleteMany({ email: label }),
    ]);
    await this.revokeSessions(userId);
    user.email = `deleted-${userId}@deleted.invalid`;
    user.name = "Deleted user";
    user.firstName = null;
    user.lastName = null;
    user.password = null;
    user.googleId = null;
    user.syncApiKey = null;
    user.openaiApiKey = undefined;
    user.anthropicApiKey = undefined;
    user.geminiApiKey = undefined;
    user.twoFactorEnabled = false;
    user.platformRole = "user";
    user.accountStatus = "deleted";
    user.suspendedAt = new Date();
    user.suspendedReason = "Deleted by an administrator";
    await user.save();
    await this.record(actor, "user.delete", {
      type: "user",
      id: userId,
      label,
    });
    return { deleted: true };
  }

  public async audit(query: {
    page?: number;
    limit?: number;
    action?: string;
    q?: string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const filter: Record<string, unknown> = {};
    if (query.action) filter.action = query.action;
    if (query.q?.trim()) {
      const rx = new RegExp(escapeRegex(query.q.trim()), "i");
      filter.$or = [{ actorEmail: rx }, { targetLabel: rx }];
    }
    const [total, rows] = await Promise.all([
      AdminAuditModel.countDocuments(filter),
      AdminAuditModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    return {
      entries: rows.map((a) => ({
        id: String(a._id),
        action: a.action,
        actorEmail: a.actorEmail,
        targetType: a.targetType,
        targetId: a.targetId ?? null,
        targetLabel: a.targetLabel ?? null,
        details: a.details ?? {},
        createdAt: a.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  public async workspaces(query: {
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const filter: Record<string, unknown> = {};
    if (query.q?.trim())
      filter.name = new RegExp(escapeRegex(query.q.trim()), "i");
    const [total, list] = await Promise.all([
      WorkspaceModel.countDocuments(filter),
      WorkspaceModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    const ids = list.map((w) => w._id);
    const [members, projects, owners] = await Promise.all([
      WorkspaceMemberModel.aggregate([
        { $match: { workspaceId: { $in: ids } } },
        { $group: { _id: "$workspaceId", n: { $sum: 1 } } },
      ]),
      ProjectModel.aggregate([
        { $match: { workspaceId: { $in: ids } } },
        { $group: { _id: "$workspaceId", n: { $sum: 1 } } },
      ]),
      UserModel.find({ _id: { $in: list.map((w) => w.ownerId) } })
        .select("email name")
        .lean(),
    ]);
    const m = new Map(
      members.map((r: { _id: Types.ObjectId; n: number }) => [
        String(r._id),
        r.n,
      ]),
    );
    const p = new Map(
      projects.map((r: { _id: Types.ObjectId; n: number }) => [
        String(r._id),
        r.n,
      ]),
    );
    const o = new Map(owners.map((u) => [String(u._id), u]));
    return {
      workspaces: list.map((w) => ({
        id: String(w._id),
        name: w.name,
        slug: w.slug,
        owner: o.get(String(w.ownerId))
          ? {
              id: String(w.ownerId),
              email: o.get(String(w.ownerId))!.email,
              name: o.get(String(w.ownerId))!.name ?? null,
            }
          : null,
        members: m.get(String(w._id)) ?? 0,
        projects: p.get(String(w._id)) ?? 0,
        createdAt: (w as { createdAt?: Date }).createdAt ?? null,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  public async workspaceDetail(workspaceId: string) {
    const id = oid(workspaceId, "Workspace");
    const ws = await WorkspaceModel.findById(id).lean();
    if (!ws) throw new AdminError(404, "Workspace not found");
    const [members, projects] = await Promise.all([
      WorkspaceMemberModel.find({ workspaceId: id }).lean(),
      ProjectModel.find({ workspaceId: id })
        .select("name createdAt")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);
    const users = await UserModel.find({
      _id: { $in: members.map((m) => m.userId) },
    })
      .select("email name accountStatus")
      .lean();
    const u = new Map(users.map((x) => [String(x._id), x]));
    const taskCounts = await TaskModel.aggregate([
      { $match: { projectId: { $in: projects.map((p) => p._id) } } },
      { $group: { _id: "$projectId", n: { $sum: 1 } } },
    ]);
    const t = new Map(
      taskCounts.map((r: { _id: Types.ObjectId; n: number }) => [
        String(r._id),
        r.n,
      ]),
    );
    return {
      id: String(ws._id),
      name: ws.name,
      slug: ws.slug,
      ownerId: String(ws.ownerId),
      createdAt: (ws as { createdAt?: Date }).createdAt ?? null,
      members: members.map((m) => ({
        userId: String(m.userId),
        role: m.role,
        email: u.get(String(m.userId))?.email ?? "Unknown",
        name: u.get(String(m.userId))?.name ?? null,
        status: this.status(u.get(String(m.userId)) ?? {}),
      })),
      projects: projects.map((p) => ({
        id: String(p._id),
        name: p.name,
        tasks: t.get(String(p._id)) ?? 0,
        createdAt: (p as { createdAt?: Date }).createdAt ?? null,
      })),
    };
  }
}

export default new AdminUsersService();
