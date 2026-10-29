import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
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
