import http from "http";
import express, { Application } from "express";
import helmet from "helmet";
import hpp from "hpp";
import { rateLimit } from "express-rate-limit";

import { Routes } from "./interfaces/routes.interface.js";
import logger from "./lib/logger.js";
import env from "./config/env.js";
import { connectDatabase } from "./config/db.config.js";
import { scheduleRolloverJob } from "./utils/rollover.js";
import { scheduleSlaJob } from "./utils/sla-scheduler.js";
import { schedulePriorityEngineJob } from "./utils/priority-engine-scheduler.js";
import { scheduleSemanticRollupJob } from "./utils/semantic-rollup-scheduler.js";
import { scheduleSdkAuthCleanupJob } from "./utils/sdk-auth-cleanup-scheduler.js";
import chatSocketServer from "./socket/chat.socket.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { AppError } from "./utils/app-error.js";
import {
  normalizeOrigin,
  setCorsHeaders,
  extractRawKey,
  validateIntegrationOrigin,
} from "./middleware/sdkAuth.middleware.js";
import { deterministicHash } from "./utils/encryption.js";

class App {
  public app: Application;
  public server: http.Server;
  public port: number;

  private databaseConnection?: Promise<void>;

  constructor(routes: Routes[]) {
    this.app = express();
    this.server = http.createServer(this.app);
    this.port = env.PORT || 5000;

    this.initializeMiddlewares();
    this.initializeRoutes(routes);
    this.initializeCronJobs();
    this.initializeSocketIO();
  }

  private initializeMiddlewares(): void {
    logger.info(`Allowed Origins : ${env.ALLOWED_ORIGINS}`);
    this.app.set("trust proxy", 1);

    this.app.use((req, _res, next) => {
      const hasAuth = !!req.headers.authorization;
      const hasSyncKey = !!req.headers["x-sync-api-key"];
      // Log the path only: query strings can carry tokens (invites, OAuth).
      logger.info(`Incoming Request: ${req.method} ${req.path}`, {
        authType: hasAuth ? "Bearer JWT" : hasSyncKey ? "Sync API Key" : "None",
        userAgent: req.headers["user-agent"],
      });
      next();
    });

    // Dynamic CORS Middleware
    this.app.use(async (req, res, next) => {
      const origin = req.headers.origin;
      if (!origin) {
        return next();
      }

      const normalizedOrigin = normalizeOrigin(origin);
      const normalizedFrontend = normalizeOrigin(env.FRONTEND_BASE_URL);

      let isAllowed = false;
      const allowedStaticOrigins = (env.ALLOWED_ORIGINS || []).map((o) =>
        normalizeOrigin(o),
      );
      if (
        normalizedOrigin === normalizedFrontend ||
        allowedStaticOrigins.includes(normalizedOrigin)
      ) {
        isAllowed = true;
      } else {
        try {
          const rawKey = extractRawKey(req);
          const service = (
            await import("./modules/sdk-integrations/service.js")
          ).default;
          if (rawKey && req.method !== "OPTIONS") {
            // For actual application requests, resolve the integration by key hash
            // to set up the request context and perform dynamic origin validation.
            const keyHash = deterministicHash(rawKey);
            const integration = await service.resolveByKeyHash(keyHash);
            if (integration) {
              const originError = validateIntegrationOrigin(
                origin,
                integration,
              );
              if (!originError) {
                isAllowed = true;
                req.sdkIntegration = integration; // attach context for downstream reuse!
              }
            }
          } else {
            // For preflight OPTIONS (stateless) or general checks, use the allowed origins check
            isAllowed = await service.isOriginAllowed(origin);
          }
        } catch (err) {
          logger.error(
            "CORS database lookup failed",
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }

      if (isAllowed) {
        setCorsHeaders(res, origin);
        if (req.method === "OPTIONS") {
          res.sendStatus(204);
          return;
        }
      } else {
        if (req.method === "OPTIONS") {
          res.status(403).json({ error: `Origin '${origin}' not allowed.` });
          return;
        }
      }

      next();
    });

    // Global rate limiter: 25 non-preflight requests per second per IP.
    const limiter = rateLimit({
      windowMs: 1000,
      max: 100,
      message:
        "Too many requests from this IP, please try again after a second.",
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.method === "OPTIONS",
    });
    this.app.use(limiter);

    this.app.use(helmet());
    this.app.use(hpp());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  private initializeRoutes(routes: Routes[]): void {
    routes.forEach((route) => {
      if (route.path) {
        this.app.use(route.path, route.router);
        return;
      }

      this.app.use(route.router);
    });

    this.app.use((_req, _res, next) => {
      next(new AppError(404, "Route not found", "NOT_FOUND"));
    });
    this.app.use(errorMiddleware);
  }

  private initializeCronJobs(): void {
    scheduleRolloverJob();
    scheduleSlaJob();
    schedulePriorityEngineJob();
    scheduleSemanticRollupJob();
    scheduleSdkAuthCleanupJob();
  }

  private initializeSocketIO(): void {
    chatSocketServer.initialize(this.server);
  }

  private initializeDatabase(): Promise<void> {
    if (!this.databaseConnection) {
      this.databaseConnection = connectDatabase();
    }

    return this.databaseConnection;
  }

  public async listen(): Promise<void> {
    try {
      await this.initializeDatabase();

      // Start background worker for project invitations
      try {
        const { startInvitationWorker } =
          await import("./modules/workspace/services/invitation-queue.service.js");
        startInvitationWorker();
        logger.info(`BullMQ invitation worker started`);
      } catch (workerError) {
        logger.error(
          "Failed to start BullMQ invitation worker",
          workerError instanceof Error
            ? workerError
            : new Error(String(workerError)),
        );
      }

      this.server.listen(this.port, () => {
        logger.info(`Server listening on port ${this.port}`);
        logger.info(
          `Google OAuth callback URI (must be an authorized redirect URI in Google Cloud Console): ${env.BACKEND_URL}/api/auth/google/callback`,
        );
        logger.info(`Socket.IO server ready for connections`);
      });
    } catch (error) {
      logger.error(
        "Server startup failed",
        error instanceof Error ? error : new Error("Unknown error"),
      );
      throw error;
    }
  }

  public getServer(): Application {
    return this.app;
  }
}

export default App;
