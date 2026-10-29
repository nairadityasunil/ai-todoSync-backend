import { Request, Response } from "express";
import logger from "../../../lib/logger.js";
import trackingService from "../services/tracking.service.js";
import { TrackingValidationError } from "../validators/tracking.validator.js";

const clientOf = (req: Request) => ({
  userAgent:
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"]
      : null,
});

class TrackingController {
  private handleError(res: Response, error: unknown, message: string) {
    if (error instanceof TrackingValidationError) {
      return res.status(error.status).json({ error: error.message });
    }

    logger.error(message, error instanceof Error ? error : undefined);
    return res.status(500).json({ error: message });
  }

  /**
   * POST /api/track
   */
  public track = async (req: Request, res: Response) => {
    try {
      const { eventName, payload, sessionId, eventId } = req.body as {
        eventName?: string;
        payload?: Record<string, unknown>;
        sessionId?: string;
        eventId?: string;
      };
      const apiKeyId = req.apiKeyId;
      const sdkIntegrationId = req.sdkIntegration?._id?.toString();

      if (!apiKeyId) {
        return res.status(401).json({ error: "API key is required" });
      }

      logger.info("Tracking single event", { apiKeyId, eventName, sessionId });

      const log = await trackingService.trackSingle({
        client: clientOf(req),
        apiKeyId,
        sdkIntegrationId,
        eventName: eventName ?? "",
        payload,
        sessionId,
        eventId,
      });

      return res.status(200).json({ success: true, logId: log?._id ?? null });
    } catch (error) {
      return this.handleError(res, error, "Failed to track event");
    }
  };

  /**
   * POST /api/identify-track
   */
  public identifyTrack = async (req: Request, res: Response) => {
    try {
      const { userIdentifier, eventName, payload, sessionId, eventId } =
        req.body as {
          userIdentifier?: string;
          eventName?: string;
          payload?: Record<string, unknown>;
          sessionId?: string;
          eventId?: string;
        };
      const apiKeyId = req.apiKeyId;

      if (!apiKeyId) {
        return res.status(401).json({ error: "API key is required" });
      }

      logger.info("Identifying and tracking event", {
        apiKeyId,
        userIdentifier,
        eventName,
      });

      if (!userIdentifier || !eventName) {
        return res
          .status(400)
          .json({ error: "userIdentifier and eventName are required" });
      }

      const log = await trackingService.trackSingle({
        client: clientOf(req),
        apiKeyId,
        userIdentifier,
        eventName,
        payload,
        sessionId,
        eventId,
      });

      return res.status(200).json({ success: true, logId: log?._id ?? null });
    } catch (error) {
      return this.handleError(res, error, "Failed to identify and track");
    }
  };

  public batch = async (req: Request, res: Response) => {
    try {
      const apiKeyId = req.apiKeyId;
      const sdkIntegrationId = req.sdkIntegration?._id?.toString();
      if (!apiKeyId) {
        return res.status(401).json({ error: "API key is required" });
      }

      logger.info("Ingesting event batch", {
        apiKeyId,
        count: Array.isArray(req.body) ? req.body.length : "unknown",
      });

      const result = await trackingService.ingestBatch(
        apiKeyId,
        req.body,
        sdkIntegrationId,
        clientOf(req),
      );
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return this.handleError(res, error, "Failed to ingest batch");
    }
  };

  public identify = async (req: Request, res: Response) => {
    try {
      const apiKeyId = req.apiKeyId;
      const { userId, traits } = req.body as {
        userId?: string;
        traits?: Record<string, unknown>;
      };

      if (!apiKeyId) {
        return res.status(401).json({ error: "API key is required" });
      }

      logger.info("Identifying user", { apiKeyId, userId });

      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }

      const user = await trackingService.identify(
        apiKeyId,
        userId,
        traits ?? {},
      );
      return res
        .status(200)
        .json({ success: true, userId: user.userIdentifier });
    } catch (error) {
      return this.handleError(res, error, "Failed to identify user");
    }
  };

  public alias = async (req: Request, res: Response) => {
    try {
      const apiKeyId = req.apiKeyId;
      const { previousId, userId } = req.body as {
        previousId?: string;
        userId?: string;
      };

      if (!apiKeyId) {
        return res.status(401).json({ error: "API key is required" });
      }

      logger.info("Aliasing user", { apiKeyId, previousId, userId });

      if (!previousId || !userId) {
        return res
          .status(400)
          .json({ error: "previousId and userId are required" });
      }

      const result = await trackingService.alias(apiKeyId, previousId, userId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return this.handleError(res, error, "Failed to alias user");
    }
  };

  public page = async (req: Request, res: Response) => {
    try {
      const apiKeyId = req.apiKeyId;
      const { url, title, referrer, userId, sessionId, eventId } = req.body as {
        url?: string;
        title?: string;
        referrer?: string;
        userId?: string;
        sessionId?: string;
        eventId?: string;
      };

      if (!apiKeyId) {
        return res.status(401).json({ error: "API key is required" });
      }

      logger.info("Tracking page view", { apiKeyId, url, userId });

      if (!url) {
        return res.status(400).json({ error: "url is required" });
      }

      const log = await trackingService.page(
        apiKeyId,
        {
          url,
          title,
          referrer,
          userIdentifier: userId,
          sessionId,
          eventId,
        },
        clientOf(req),
      );

      return res.status(200).json({ success: true, logId: log?._id ?? null });
    } catch (error) {
      return this.handleError(res, error, "Failed to track page event");
    }
  };

  public config = async (_req: Request, res: Response) =>
    res.status(200).json(trackingService.getConfig());
}

export default new TrackingController();
