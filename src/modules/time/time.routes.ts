import type { Response } from "express";
import { Router } from "express";

import { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import { isProjectMember } from "../../middleware/project-access.middleware.js";
import type { AuthenticatedRequest } from "../../types/auth.js";
import timeService from "./time.service.js";

const param = (v: string | string[] | undefined): string =>
  typeof v === "string" ? v : (v?.[0] ?? "");

const run =
  (
    fn: (
      userId: string,
      projectId: string,
      req: AuthenticatedRequest,
    ) => Promise<unknown>,
    status = 200,
  ) =>
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const data = await fn(
        req.user._id.toString(),
        param(req.params.projectId),
        req,
      );
      res.status(status).json({ message: "OK", data });
    } catch (error) {
      const code = (error as { status?: number }).status ?? 500;
      res.status(code).json({ error: (error as Error).message });
    }
  };

/** Weekly time logging per project: GET /week, POST /entries, PATCH and DELETE /entries/:entryId. */
class TimeRoutes implements Routes {
  public path = "/api/projects/:projectId/time";
  public router = Router({ mergeParams: true });

  constructor() {
    this.router.use(authMiddleware);
    this.router.use(isProjectMember);
    this.router.get(
      "/week",
      run((u, p, req) => timeService.getWeek(u, p, req.query)),
    );
    this.router.get(
      "/range",
      run((u, p, req) => timeService.getRange(u, p, req.query)),
    );
    this.router.get(
      "/tasks/:taskId",
      run((u, p, req) =>
        timeService.getTaskTime(u, p, param(req.params.taskId)),
      ),
    );
    this.router.post(
      "/entries",
      run(
        (u, p, req) =>
          timeService.addEntry(
            u,
            p,
            (req.body ?? {}) as Record<string, unknown>,
          ),
        201,
      ),
    );
    this.router.patch(
      "/entries/:entryId",
      run(async (u, p, req) => {
        await timeService.updateEntry(
          u,
          p,
          param(req.params.entryId),
          (req.body ?? {}) as Record<string, unknown>,
        );
        return { updated: true };
      }),
    );
    this.router.delete(
      "/entries/:entryId",
      run(async (u, p, req) => {
        await timeService.deleteEntry(u, p, param(req.params.entryId));
        return { deleted: true };
      }),
    );
  }
}

export default TimeRoutes;
