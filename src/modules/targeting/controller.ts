import type { Request, Response } from "express";
import { isAppError } from "../../utils/app-error.js";
import { getTenantIdFromRequest } from "./permissions.js";
import targetingService from "./service.js";
import {
  validateCreateTargetingSegmentDto,
  validateEvaluateRulesDto,
  validateUpdateTargetingSegmentDto,
} from "./validators.js";

const getParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

class TargetingController {
  public listSegments = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = getTenantIdFromRequest(req);
      const segments = await targetingService.listSegments(tenantId);
      res.status(200).json({ data: { segments } });
    } catch (error) {
      this.respondError(res, error);
    }
  };

  public createSegment = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = getTenantIdFromRequest(req);
      const dto = validateCreateTargetingSegmentDto(req.body);
      const segment = await targetingService.createSegment(
        tenantId,
        tenantId,
        dto,
      );
      res.status(201).json({ data: { segment } });
    } catch (error) {
      this.respondError(res, error);
    }
  };

  public updateSegment = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = getTenantIdFromRequest(req);
      const dto = validateUpdateTargetingSegmentDto(req.body);
      const segment = await targetingService.updateSegment(
        tenantId,
        getParam(req.params.segmentId),
        tenantId,
        dto,
      );
      res.status(200).json({ data: { segment } });
    } catch (error) {
      this.respondError(res, error);
    }
  };

  public deleteSegment = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = getTenantIdFromRequest(req);
      await targetingService.deleteSegment(
        tenantId,
        getParam(req.params.segmentId),
      );
      res.status(200).json({ data: { deleted: true } });
    } catch (error) {
      this.respondError(res, error);
    }
  };

  public evaluate = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = getTenantIdFromRequest(req);
      const dto = validateEvaluateRulesDto(req.body);
      const result = await targetingService.evaluate({
        rules: dto.rules,
        guideId: dto.guideId,
        context: { ...dto, tenantId },
      });
      res.status(200).json({ data: result });
    } catch (error) {
      this.respondError(res, error);
    }
  };

  private respondError(res: Response, error: unknown): void {
    if (isAppError(error)) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }

    if ((error as { code?: number })?.code === 11000) {
      res.status(409).json({
        error: "A segment with this name already exists",
        code: "DUPLICATE_SEGMENT",
      });
      return;
    }

    if ((error as { name?: string })?.name === "CastError") {
      res
        .status(404)
        .json({ error: "Targeting segment not found", code: "NOT_FOUND" });
      return;
    }

    res.status(500).json({ error: "Targeting request failed" });
  }
}

export default new TargetingController();
