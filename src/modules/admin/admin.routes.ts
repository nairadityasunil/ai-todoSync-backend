import type { Response } from "express";
import { Router } from "express";

import { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import type { AuthenticatedRequest } from "../../types/auth.js";
import analytics from "./admin-analytics.service.js";
import users, { AdminError, type Actor } from "./admin-users.service.js";
import { requireSuperAdmin } from "./super-admin.js";

const param = (v: string | string[] | undefined): string =>
  typeof v === "string" ? v : (v?.[0] ?? "");

const actorOf = (req: AuthenticatedRequest): Actor => ({
  id: req.user!._id.toString(),
  email: req.user!.email,
  ip: req.ip ?? null,
});

const handle =
  (fn: (req: AuthenticatedRequest) => Promise<unknown>, status = 200) =>
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      res.status(status).json({ message: "OK", data: await fn(req) });
    } catch (error) {
      const code =
        error instanceof AdminError
          ? error.status
          : ((error as { status?: number }).status ?? 500);
      res.status(code).json({ error: (error as Error).message });
    }
  };

/** Platform admin API. Every route needs a signed-in super admin; every change is written to the audit log. */
class AdminRoutes implements Routes {
  public path = "/api/admin";
  public router = Router();

  constructor() {
    const r = this.router;
    r.use(authMiddleware, requireSuperAdmin);
    r.get(
      "/analytics",
      handle((req) => analytics.overview(Number(req.query.days) || 30)),
    );
    r.get(
      "/users",
      handle((req) => users.list(req.query as Record<string, never>)),
    );
    r.post(
      "/users",
      handle((req) => users.create(actorOf(req), req.body ?? {}), 201),
    );
    r.get(
      "/users/:id",
      handle((req) => users.detail(param(req.params.id))),
    );
    r.patch(
      "/users/:id",
      handle((req) =>
        users.update(actorOf(req), param(req.params.id), req.body ?? {}),
      ),
    );
    r.post(
      "/users/:id/suspend",
      handle((req) =>
        users.suspend(actorOf(req), param(req.params.id), req.body?.reason),
      ),
    );
    r.post(
      "/users/:id/reactivate",
      handle((req) => users.reactivate(actorOf(req), param(req.params.id))),
    );
    r.post(
      "/users/:id/make-super-admin",
      handle((req) =>
        users.setSuperAdmin(actorOf(req), param(req.params.id), true),
      ),
    );
    r.post(
      "/users/:id/remove-super-admin",
      handle((req) =>
        users.setSuperAdmin(actorOf(req), param(req.params.id), false),
      ),
    );
    r.post(
      "/users/:id/reset-password",
      handle((req) => users.resetPassword(actorOf(req), param(req.params.id))),
    );
    r.post(
      "/users/:id/disable-2fa",
      handle((req) =>
        users.disableTwoFactor(actorOf(req), param(req.params.id)),
      ),
    );
    r.post(
      "/users/:id/sign-out",
      handle((req) =>
        users.signOutEverywhere(actorOf(req), param(req.params.id)),
      ),
    );
    r.delete(
      "/users/:id",
      handle((req) =>
        users.remove(
          actorOf(req),
          param(req.params.id),
          req.body?.confirmEmail,
        ),
      ),
    );
    r.get(
      "/workspaces",
      handle((req) => users.workspaces(req.query as Record<string, never>)),
    );
    r.get(
      "/workspaces/:id",
      handle((req) => users.workspaceDetail(param(req.params.id))),
    );
    r.get(
      "/audit",
      handle((req) => users.audit(req.query as Record<string, never>)),
    );
  }
}

export default AdminRoutes;
