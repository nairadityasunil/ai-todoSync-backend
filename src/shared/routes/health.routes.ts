import { Router } from "express";
import { Routes } from "../../interfaces/routes.interface.js";
import { isDatabaseConnected } from "../../config/db.config.js";

class HealthRoutes implements Routes {
  public path = "/health";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const handler = (_req: any, res: any) => {
      const dbConnected = isDatabaseConnected();
      res.status(200).json({
        status: dbConnected ? "ok" : "degraded",
        database: dbConnected ? "connected" : "disconnected",
        timestamp: new Date().toISOString(),
      });
    };
    this.router.get("/", handler);
    this.router.get("/health", handler);
  }
}

export default HealthRoutes;
