import AnalyticsKeyModel from "../analytics/models/analytics-key.model.js";
import trackingService from "../analytics/services/tracking.service.js";
import engagementRepository from "./repository.js";
import type { EngagementTrackDto, RuntimeGuideDto } from "./dtos.js";
import type { EngagementEventName } from "./types.js";

const COMPLETED_EVENTS: EngagementEventName[] = [
  "guide_completed",
  "survey_completed",
];

const DISMISSED_EVENTS: EngagementEventName[] = [
  "guide_dismissed",
  "survey_abandoned",
];

class EngagementService {
  public async recordInteraction(input: {
    tenantId: string;
    sdkIntegrationId: string;
    actorUserId?: string;
    dto: EngagementTrackDto;
  }) {
    const experienceId =
      input.dto.guideId ??
      (input.dto.surveyId ? `survey:${input.dto.surveyId}` : undefined) ??
      (input.dto.checklistId
        ? `checklist:${input.dto.checklistId}`
        : undefined);
    const userId = input.dto.userId ?? input.actorUserId;

    if (input.dto.eventName === "survey_completed" && input.dto.surveyId) {
      const isAlreadyProcessed =
        input.dto.properties &&
        (input.dto.properties.responseId || input.dto.properties.isProcessed);
      if (!isAlreadyProcessed) {
        const surveyService = (await import("../surveys/service.js")).default;
        await surveyService.submitResponse(
          input.tenantId,
          input.sdkIntegrationId,
          input.dto.surveyId,
          {
            userId,
            sessionId: input.dto.sessionId,
            answers: (input.dto.properties?.answers || {}) as Record<
              string,
              unknown
            >,
            metadata: {
              ...((input.dto.properties?.metadata || {}) as Record<
                string,
                unknown
              >),
              // The SDK retries submissions; this key lets a retry be ignored.
              ...(typeof input.dto.properties?.idempotencyKey === "string"
                ? { idempotencyKey: input.dto.properties.idempotencyKey }
                : {}),
            },
          },
        );
      }
    }

    if (experienceId) {
      const isRuntimeDelivery =
        input.dto.properties?.source === "runtime_delivery";
      await engagementRepository.upsertExposure(
        {
          tenantId: input.tenantId,
          sdkIntegrationId: input.sdkIntegrationId,
          guideId: experienceId,
          userId,
          sessionId: input.dto.sessionId,
        },
        {
          status: this.resolveExposureStatus(input.dto.eventName),
          stepId: input.dto.stepId,
          metadata: input.dto.properties,
          incrementDisplay:
            !isRuntimeDelivery && input.dto.eventName === "guide_shown",
        },
      );
    }

    if (userId && input.dto.eventName === "guide_shown") {
      await engagementRepository.incrementMtu({
        tenantId: input.tenantId,
        sdkIntegrationId: input.sdkIntegrationId,
        userId,
        guideId: input.dto.guideId,
        surveyId: input.dto.surveyId,
      });
    }

    await this.trackThroughExistingAnalytics(input.tenantId, {
      eventName: input.dto.eventName,
      userId,
      sessionId: input.dto.sessionId,
      payload: {
        guideId: input.dto.guideId,
        surveyId: input.dto.surveyId,
        checklistId: input.dto.checklistId,
        stepId: input.dto.stepId,
        ...(input.dto.properties ?? {}),
      },
    });

    return { success: true };
  }

  public async recordRuntimeDelivery(input: {
    tenantId: string;
    sdkIntegrationId: string;
    userId?: string;
    sessionId?: string;
    guides: RuntimeGuideDto[];
  }): Promise<void> {
    await Promise.all(
      input.guides.map(async (guide) => {
        const surveyId =
          typeof guide.metadata.surveyId === "string"
            ? guide.metadata.surveyId
            : undefined;
        const checklistId =
          typeof guide.metadata.checklistId === "string"
            ? guide.metadata.checklistId
            : undefined;

        await this.recordInteraction({
          tenantId: input.tenantId,
          sdkIntegrationId: input.sdkIntegrationId,
          actorUserId: input.userId,
          dto: {
            eventName: "guide_shown",
            guideId: surveyId || checklistId ? undefined : guide.id,
            surveyId,
            checklistId,
            userId: input.userId,
            sessionId: input.sessionId,
            properties: { source: "runtime_delivery", type: guide.type },
          },
        });
      }),
    );
  }

  public countMtu(sdkIntegrationId: string, month: string): Promise<number> {
    return engagementRepository.countMtu(sdkIntegrationId, month);
  }

  private resolveExposureStatus(eventName: EngagementEventName) {
    if (COMPLETED_EVENTS.includes(eventName)) {
      return "completed" as const;
    }

    if (DISMISSED_EVENTS.includes(eventName)) {
      return "dismissed" as const;
    }

    if (eventName === "guide_started" || eventName === "survey_started") {
      return "started" as const;
    }

    return "shown" as const;
  }

  private async trackThroughExistingAnalytics(
    tenantId: string,
    input: {
      eventName: EngagementEventName;
      userId?: string;
      sessionId?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const key = await AnalyticsKeyModel.findOne({
      userId: tenantId,
      status: "active",
    })
      .sort({ createdAt: -1 })
      .exec();

    if (!key) {
      return;
    }

    await trackingService.trackSingle({
      apiKeyId: key._id.toString(),
      eventName: input.eventName,
      userIdentifier: input.userId,
      sessionId: input.sessionId,
      payload: {
        ...input.payload,
        source: "engagement",
      },
    });
  }
}

export default new EngagementService();
