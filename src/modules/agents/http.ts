import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import { approverScope } from "./approval.service.js";

/**
 * Request helpers shared by the agent governance and vendor controllers.
 */

export const userIdOf = (req: AuthenticatedRequest): string => {
  const id = req.user?._id?.toString();
  if (!id) throw new AppError(401, "Authentication required", "AUTH_REQUIRED");
  return id;
};

export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const param = (req: AuthenticatedRequest, name: string): string => {
  const value = (req.params as Record<string, string | undefined>)[name];
  if (!value || !Types.ObjectId.isValid(value))
    throw new AppError(404, "Not found", "NOT_FOUND");
  return value;
};

/** Workspaces the user administers (OWNER/ADMIN). */
export const adminWorkspaces = async (
  userId: string,
): Promise<Types.ObjectId[]> => (await approverScope(userId)).workspaceIds;

/** The workspace a request is about: ?workspaceId, else the first one the user administers. */
export const workspaceFor = async (
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

export const requireWorkspace = async (
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

/**
 * The workspace for something any member may read (the activity timeline, which scopes what each person sees):
 * ?workspaceId if the person belongs to it, else the first one they administer, else the one they joined first.
 * Unlike requireWorkspace, this does not need the admin role.
 */
export const requireMemberWorkspace = async (
  req: AuthenticatedRequest,
  userId: string,
): Promise<Types.ObjectId> => {
  const requested =
    str(req.query.workspaceId) ??
    str((req.body as Record<string, unknown> | undefined)?.workspaceId);
  if (requested) {
    if (!Types.ObjectId.isValid(requested))
      throw new AppError(400, "workspaceId is not valid", "BAD_REQUEST");
    const member = await WorkspaceMemberModel.exists({
      workspaceId: requested,
      userId,
    });
    if (!member)
      throw new AppError(
        403,
        "You are not a member of that workspace",
        "FORBIDDEN",
      );
    return new Types.ObjectId(requested);
  }
  const admin = await adminWorkspaces(userId);
  if (admin[0]) return admin[0];
  const first = await WorkspaceMemberModel.find({ userId })
    .sort({ createdAt: 1 })
    .select("workspaceId")
    .limit(1)
    .lean();
  if (!first[0])
    throw new AppError(403, "You are not in a workspace", "FORBIDDEN");
  return new Types.ObjectId(String(first[0].workspaceId));
};
