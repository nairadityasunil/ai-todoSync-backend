import { stepFunnel } from "./step-funnel.js";
import { AppError } from "../../utils/app-error.js";
import engagementRepository from "../engagement/repository.js";
import type { RuntimeGuideDto } from "../engagement/dtos.js";
import type { TargetingRuntimeContext } from "../engagement/types.js";
import targetingService from "../targeting/service.js";
import type { CreateGuideDto, GuideQueryDto, UpdateGuideDto } from "./dtos.js";
import type { IGuideDocument } from "./model.js";
import guideRepository from "./repository.js";

class GuideService {
  public listGuides(
    tenantId: string,
    sdkIntegrationId: string,
    query: GuideQueryDto,
  ) {
    return guideRepository.listGuides(tenantId, sdkIntegrationId, query);
  }

  public async getGuide(
    tenantId: string,
    sdkIntegrationId: string,
    guideId: string,
  ) {
    const guide = await guideRepository.getGuide(
      tenantId,
      sdkIntegrationId,
      guideId,
    );

    if (!guide) {
      throw new AppError(404, "Guide not found", "NOT_FOUND");
    }

    return guide;
  }

  public createGuide(
    tenantId: string,
    sdkIntegrationId: string,
    createdBy: string,
    dto: CreateGuideDto,
  ) {
    return guideRepository.createGuide(
      tenantId,
      sdkIntegrationId,
      createdBy,
      dto,
    );
  }

  public async updateGuide(
    tenantId: string,
    sdkIntegrationId: string,
    guideId: string,
    updatedBy: string,
    dto: UpdateGuideDto,
  ) {
    const existing = await this.getGuide(tenantId, sdkIntegrationId, guideId);
    const guide = await guideRepository.updateGuide(
      tenantId,
      sdkIntegrationId,
      guideId,
      updatedBy,
      dto,
      existing,
    );

    if (!guide) {
      throw new AppError(404, "Guide not found", "NOT_FOUND");
    }

    return guide;
  }

  public async updateStatus(
    tenantId: string,
    sdkIntegrationId: string,
    guideId: string,
    updatedBy: string,
    status: "DRAFT" | "LIVE" | "PAUSED" | "ARCHIVED",
  ) {
    const guide = await guideRepository.updateStatus(
      tenantId,
      sdkIntegrationId,
      guideId,
      updatedBy,
      status,
    );

    if (!guide) {
      throw new AppError(404, "Guide not found", "NOT_FOUND");
    }

    return guide;
  }

  public async deleteGuide(
    tenantId: string,
    sdkIntegrationId: string,
    guideId: string,
  ) {
    const result = await guideRepository.deleteGuide(
      tenantId,
      sdkIntegrationId,
      guideId,
    );

    if (result.deletedCount === 0) {
      throw new AppError(404, "Guide not found", "NOT_FOUND");
    }
  }

  public async getEligibleGuides(
    tenantId: string,
    sdkIntegrationId: string,
    context: Omit<TargetingRuntimeContext, "tenantId">,
  ): Promise<RuntimeGuideDto[]> {
    const manualTourId = context.eventProperties?.tourId;
    if (
      context.eventName === "manual_tour" &&
      typeof manualTourId === "string"
    ) {
      const guide = await guideRepository
        .getGuide(tenantId, sdkIntegrationId, manualTourId)
        .catch(() => null);
      if (guide) {
        return [
          this.toRuntimeDto(guide, {
            reasons: ["Manual tour trigger"],
            matchedConditions: [],
            failedConditions: [],
          }),
        ];
      }
    }

    const guides = await guideRepository.listLiveGuides(
      tenantId,
      sdkIntegrationId,
    );
    const contextWithTenant = { ...context, tenantId };
    const evaluated = await Promise.all(
      guides.map(async (guide) => {
        const eligibility = await targetingService.evaluate({
          rules: guide.targetingRules,
          context: contextWithTenant,
          guideId: guide._id.toString(),
          frequencyRules: guide.frequencyRules,
          scheduleRules: guide.scheduleRules,
        });
        return { guide, eligibility };
      }),
    );

    return evaluated
      .filter((entry) => entry.eligibility.eligible)
      .sort((left, right) =>
        targetingService.comparePriority(
          left.guide.priority,
          right.guide.priority,
        ),
      )
      .map((entry) => this.toRuntimeDto(entry.guide, entry.eligibility))
      .slice(0, 5);
  }

  public async getGuideExposureSummary(
    tenantId: string,
    sdkIntegrationId: string,
    guideId: string,
  ) {
    const guide = await this.getGuide(tenantId, sdkIntegrationId, guideId);
    const exposures = await engagementRepository.findExposuresForGuide(
      tenantId,
      guideId,
    );
    const total = exposures.length;
    const completed = exposures.filter(
      (exposure) => exposure.status === "completed",
    ).length;
    const dismissed = exposures.filter(
      (exposure) => exposure.status === "dismissed",
    ).length;
    const impressions = exposures.reduce(
      (sum, exposure) => sum + exposure.displayCount,
      0,
    );

    return {
      guideId,
      impressions,
      uniqueUsers: total,
      completions: completed,
      dismissals: dismissed,
      completionRate: total > 0 ? completed / total : 0,
      dismissalRate: total > 0 ? dismissed / total : 0,
      steps: stepFunnel(guide.steps ?? [], exposures),
    };
  }

  private toRuntimeDto(
    guide: IGuideDocument,
    eligibility: RuntimeGuideDto["eligibility"],
  ): RuntimeGuideDto {
    return {
      id: guide._id.toString(),
      title: guide.title,
      description: guide.description,
      type: guide.type,
      priority: guide.priority,
      theme: guide.theme,
      steps: guide.steps,
      targetingRules: guide.targetingRules,
      frequencyRules: guide.frequencyRules as Record<string, unknown>,
      scheduleRules: guide.scheduleRules as Record<string, unknown>,
      metadata: guide.metadata,
      eligibility,
    };
  }
}

export default new GuideService();
