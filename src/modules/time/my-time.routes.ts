import type { Response } from "express";
import { Router } from "express";

import { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import type { AuthenticatedRequest } from "../../types/auth.js";
import timeService from "./time.service.js";

/** The signed-in person's own time across all their projects: GET /api/time/my-week?start=YYYY-MM-DD. */
class MyTimeRoutes implements Routes {
  public path = "/api/time";
  public router = Router();

  constructor() {
    this.router.use(authMiddleware);
    this.router.get(
      "/my-week",
      async (req: AuthenticatedRequest, res: Response): Promise<void> => {
        try {
          if (!req.user) {
            res.status(401).json({ error: "Authentication required" });
            return;
          }
          const data = await timeService.getMyWeek(
            req.user._id.toString(),
            req.query,
          );
          res.status(200).json({ message: "OK", data });
        } catch (error) {
          const code = (error as { status?: number }).status ?? 500;
          res.status(code).json({ error: (error as Error).message });
        }
      },
    );
  }
}

export default MyTimeRoutes;
