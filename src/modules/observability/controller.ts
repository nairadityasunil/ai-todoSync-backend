import type { Request, Response } from "express";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import { userIdOf } from "../agents/http.js";
import * as aiGovernance from "../ai-governance/service.js";
import * as service from "./service.js";

const qs = (req: AuthenticatedRequest) => req.query as Record<string, unknown>;
const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data });

class ObservabilityController {
  /** POST /api/logs: authenticated like event tracking, by the SDK integration. */
  public ingest = async (req: Request, res: Response) => {
    const integrationId = req.sdkIntegration?._id?.toString();
    if (!integrationId)
      throw new AppError(401, "An SDK integration is required", "UNAUTHORIZED");
    const out = await service.ingestLogs(integrationId, req.body);
    res.status(202).json({ success: true, ...out });
  };

  /** POST /api/ai/interactions: an app's AI calls, from the SDK, into AI Governance. */
  public aiInteractions = async (req: Request, res: Response) => {
    const integrationId = req.sdkIntegration?._id?.toString();
    if (!integrationId)
      throw new AppError(401, "An SDK integration is required", "UNAUTHORIZED");
    const out = await aiGovernance.ingestFromIntegration(
      integrationId,
      req.body,
    );
    res.status(202).json({ success: true, ...out });
  };

  public search = async (req: AuthenticatedRequest, res: Response) =>
    ok(
      res,
      await service.searchLogs({ userId: userIdOf(req), ...qs(req) } as never),
    );
  public stats = async (req: AuthenticatedRequest, res: Response) =>
    ok(
      res,
      await service.logStats({ userId: userIdOf(req), ...qs(req) } as never),
    );
  public live = async (req: AuthenticatedRequest, res: Response) =>
    ok(
      res,
      await service.liveEvents({ userId: userIdOf(req), ...qs(req) } as never),
    );
  public persons = async (req: AuthenticatedRequest, res: Response) =>
    ok(
      res,
      await service.listPersons({ userId: userIdOf(req), ...qs(req) } as never),
    );
  public person = async (req: AuthenticatedRequest, res: Response) =>
    ok(
      res,
      await service.personProfile({
        userId: userIdOf(req),
        integrationId: qs(req).integrationId,
        identifier: String(
          (req.params as Record<string, string>).identifier ?? "",
        ),
        limit: qs(req).limit,
      }),
    );
}

export default new ObservabilityController();
