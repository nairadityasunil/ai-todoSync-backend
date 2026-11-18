import type { Response, NextFunction } from "express";

import type { AuthenticatedRequest } from "../../types/auth.js";

/** Emails listed in SUPER_ADMIN_EMAILS (comma separated) are always super admins. */
const listed = (): Set<string> =>
  new Set(
    (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

export const isEnvSuperAdmin = (email: string): boolean =>
  listed().has(email.trim().toLowerCase());

/** A super admin runs the platform: set in the database by another super admin, or by SUPER_ADMIN_EMAILS. */
export const isSuperAdmin = (user: {
  email: string;
  platformRole?: string | null;
  accountStatus?: string | null;
}): boolean =>
  (user.accountStatus ?? "active") === "active" &&
  (user.platformRole === "super_admin" || isEnvSuperAdmin(user.email));

/** Put after the auth middleware on every admin route. */
export const requireSuperAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!isSuperAdmin(user)) {
    res.status(403).json({ error: "Platform admin access required" });
    return;
  }
  next();
};
