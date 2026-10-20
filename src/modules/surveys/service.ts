import { AppError } from "../../utils/app-error.js";
import engagementService from "../engagement/service.js";
import type { RuntimeGuideDto } from "../engagement/dtos.js";
import type {
  NpsCategory,
  TargetingRuntimeContext,
} from "../engagement/types.js";
import { GuideExposureModel } from "../engagement/model.js";
import targetingService from "../targeting/service.js";
import type {
  CreateSurveyDto,
  SubmitSurveyResponseDto,
  SurveyQueryDto,
  UpdateSurveyDto,
} from "./dtos.js";
import type { ISurveyDocument } from "./model.js";
import surveyRepository from "./repository.js";

class SurveyService {
  public listSurveys(
    tenantId: string,
    sdkIntegrationId: string,
    query: SurveyQueryDto,
  ) {
    return surveyRepository.listSurveys(tenantId, sdkIntegrationId, query);
  }

  public listResponses(
    tenantId: string,
    sdkIntegrationId: string,
    surveyId: string,
  ) {
    return surveyRepository.listResponses(tenantId, sdkIntegrationId, surveyId);
  }

  public async getSurvey(
    tenantId: string,
    sdkIntegrationId: string,
    surveyId: string,
  ) {
    const survey = await surveyRepository.getSurvey(
      tenantId,
      sdkIntegrationId,
      surveyId,
    );

    if (!survey) {
      throw new AppError(404, "Survey not found", "NOT_FOUND");
    }

    return survey;
  }

  public createSurvey(
    tenantId: string,
    sdkIntegrationId: string,
    createdBy: string,
    dto: CreateSurveyDto,
  ) {
    return surveyRepository.createSurvey(
      tenantId,
      sdkIntegrationId,
      createdBy,
      dto,
    );
  }

  public async updateSurvey(
    tenantId: string,
    sdkIntegrationId: string,
    surveyId: string,
    updatedBy: string,
    dto: UpdateSurveyDto,
  ) {
    const survey = await surveyRepository.updateSurvey(
      tenantId,
      sdkIntegrationId,
      surveyId,
      updatedBy,
      dto,
    );

    if (!survey) {
      throw new AppError(404, "Survey not found", "NOT_FOUND");
    }

    return survey;
  }

  public async deleteSurvey(
    tenantId: string,
    sdkIntegrationId: string,
    surveyId: string,
  ) {
    const result = await surveyRepository.deleteSurvey(
      tenantId,
      sdkIntegrationId,
      surveyId,
    );

    if (result.deletedCount === 0) {
      throw new AppError(404, "Survey not found", "NOT_FOUND");
    }
  }

  public async submitResponse(
    tenantId: string,
    sdkIntegrationId: string,
    surveyId: string,
    dto: SubmitSurveyResponseDto,
  ) {
    const survey = await this.getSurvey(tenantId, sdkIntegrationId, surveyId);

    // A retried submission (same idempotency key) returns the stored response
    // instead of counting the same answers twice.
    const idempotencyKey =
      typeof dto.metadata?.idempotencyKey === "string"
        ? dto.metadata.idempotencyKey
        : null;
    if (idempotencyKey) {
      const existing = await surveyRepository.findResponseByIdempotencyKey(
        sdkIntegrationId,
        surveyId,
        idempotencyKey,
      );
      if (existing) {
        return existing;
      }
    }

    const npsScore = this.extractNpsScore(survey, dto.answers);
    const category = this.categorizeNps(npsScore);
    const response = await surveyRepository.createResponse({
      tenantId,
      sdkIntegrationId,
      survey,
      dto,
      npsScore,
      category,
    });

    await engagementService.recordInteraction({
      tenantId,
      sdkIntegrationId,
      actorUserId: dto.userId,
      dto: {
        eventName: "survey_completed",
        surveyId,
        userId: dto.userId,
        sessionId: dto.sessionId,
        properties: {
          npsScore,
          category,
          responseId: response._id.toString(),
        },
      },
    });

    return response;
  }

  public async getEligibleSurveys(
    tenantId: string,
    sdkIntegrationId: string,
    context: Omit<TargetingRuntimeContext, "tenantId">,
  ): Promise<RuntimeGuideDto[]> {
    const manualTourId = context.eventProperties?.tourId;
    if (
      context.eventName === "manual_tour" &&
      typeof manualTourId === "string"
    ) {
      const cleanTourId = manualTourId.replace(/^survey:/, "");
      const survey = await surveyRepository
        .getSurvey(tenantId, sdkIntegrationId, cleanTourId)
        .catch(() => null);
      if (survey) {
        return [
          this.toRuntimeDto(survey, {
            reasons: ["Manual tour trigger"],
            matchedConditions: [],
            failedConditions: [],
          }),
        ];
      }
    }

    const surveys = await surveyRepository.listLiveSurveys(
      tenantId,
      sdkIntegrationId,
    );
    const contextWithTenant = { ...context, tenantId };
    const evaluated = await Promise.all(
      surveys.map(async (survey) => {
        const [targeting, trigger] = await Promise.all([
          targetingService.evaluate({
            rules: survey.targetingRules,
            context: contextWithTenant,
            guideId: `survey:${survey._id.toString()}`,
            frequencyRules: survey.frequencyRules,
            scheduleRules: survey.scheduleRules,
          }),
          targetingService.evaluate({
            rules: survey.triggerRules,
            context: contextWithTenant,
          }),
        ]);

        return {
          survey,
          eligibility: {
            eligible: targeting.eligible && trigger.eligible,
            reasons: [...targeting.reasons, ...trigger.reasons],
            matchedConditions: [
              ...targeting.matchedConditions,
              ...trigger.matchedConditions,
            ],
            failedConditions: [
              ...targeting.failedConditions,
              ...trigger.failedConditions,
            ],
          },
        };
      }),
    );

    return evaluated
      .filter((entry) => entry.eligibility.eligible)
      .sort((left, right) =>
        targetingService.comparePriority(
          left.survey.priority,
          right.survey.priority,
        ),
      )
      .map((entry) => this.toRuntimeDto(entry.survey, entry.eligibility));
  }

  public async getSurveyAnalytics(
    tenantId: string,
    sdkIntegrationId: string,
    surveyId: string,
  ) {
    const survey = await this.getSurvey(tenantId, sdkIntegrationId, surveyId);
    const responses = await surveyRepository.listResponses(
      tenantId,
      sdkIntegrationId,
      surveyId,
    );

    const exposures = await GuideExposureModel.find({
      sdkIntegrationId,
      guideId: `survey:${surveyId}`,
    }).exec();

    const totalImpressions = exposures.reduce(
      (sum, exp) => sum + (exp.displayCount ?? 0),
      0,
    );
    const uniqueUsersCount = new Set(
      exposures.map((exp) => exp.userId).filter(Boolean),
    ).size;
    const starts = exposures.filter((exp) => exp.status !== "shown").length;
    const submissions = responses.length;
    const dismissals = exposures.filter(
      (exp) => exp.status === "dismissed" || exp.status === "abandoned",
    ).length;

    const completionRate =
      totalImpressions > 0 ? (submissions / totalImpressions) * 100 : 0;
    const dropOffRate =
      starts > 0 ? ((starts - submissions) / starts) * 100 : 0;

    let totalCompletionTime = 0;
    let completionTimeCount = 0;

    exposures.forEach((exp) => {
      if (exp.startedAt && exp.completedAt) {
        totalCompletionTime +=
          (exp.completedAt.getTime() - exp.startedAt.getTime()) / 1000;
        completionTimeCount++;
      }
    });

    if (completionTimeCount === 0) {
      responses.forEach((res) => {
        if (res.metadata && typeof res.metadata.startedAt === "string") {
          const start = new Date(res.metadata.startedAt).getTime();
          const end = new Date(res.submittedAt).getTime();
          if (end > start) {
            totalCompletionTime += (end - start) / 1000;
            completionTimeCount++;
          }
        }
      });
    }
    const averageCompletionTime =
      completionTimeCount > 0 ? totalCompletionTime / completionTimeCount : 0;

    const promoters = responses.filter((r) => r.category === "PROMOTER").length;
    const passives = responses.filter((r) => r.category === "PASSIVE").length;
    const detractors = responses.filter(
      (r) => r.category === "DETRACTOR",
    ).length;
    const nps =
      submissions > 0 ? ((promoters - detractors) / submissions) * 100 : 0;

    const questionAnalytics = survey.questions.map((q) => {
      const qAnswers = responses
        .map((r) => {
          if (Array.isArray(r.answers)) {
            return r.answers.find((a: any) => a.questionId === q.id)?.value;
          }
          return (r.answers as Record<string, unknown>)[q.id];
        })
        .filter((val) => val !== undefined && val !== null);

      const answeredCount = qAnswers.length;
      const skippedCount = submissions - answeredCount;

      let averageScore = 0;
      const distribution: Record<string, number> = {};

      if (
        ["NPS", "RATING_SCALE", "OPINION_SCALE", "CSAT", "CES"].includes(q.type)
      ) {
        const scores = qAnswers.map(Number).filter(Number.isFinite);
        if (scores.length > 0) {
          averageScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
        }
      }

      // Multiple-choice answers are arrays: count each selected option.
      qAnswers.forEach((ans) => {
        const values = Array.isArray(ans) ? ans : [ans];
        values.forEach((value) => {
          const key =
            typeof value === "object" && value !== null
              ? JSON.stringify(value)
              : String(value);
          distribution[key] = (distribution[key] ?? 0) + 1;
        });
      });

      let mostSelectedOption: string | null = null;
      let leastSelectedOption: string | null = null;
      let maxCount = -1;
      let minCount = Infinity;

      Object.entries(distribution).forEach(([key, count]) => {
        if (count > maxCount) {
          maxCount = count;
          mostSelectedOption = key;
        }
        if (count < minCount) {
          minCount = count;
          leastSelectedOption = key;
        }
      });

      return {
        questionId: q.id,
        title: q.title,
        type: q.type,
        responseCount: answeredCount,
        skippedCount,
        averageScore,
        distribution,
        mostSelectedOption,
        leastSelectedOption,
      };
    });

    return {
      surveyId,
      responses: submissions,
      nps,
      promoters,
      passives,
      detractors,
      responseRate:
        totalImpressions > 0 ? (submissions / totalImpressions) * 100 : 0,
      impressions: totalImpressions,
      eligibleUsers: uniqueUsersCount,
      displays: totalImpressions,
      starts,
      submissions,
      dismissals,
      completionRate,
      dropOffRate,
      averageCompletionTime,
      questionAnalytics,
      weeklyTrends: this.buildTrend(responses, "week"),
      monthlyTrends: this.buildTrend(responses, "month"),
    };
  }

  private toRuntimeDto(
    survey: ISurveyDocument,
    eligibility: RuntimeGuideDto["eligibility"],
  ): RuntimeGuideDto {
    return {
      id: `survey:${survey._id.toString()}`,
      title: survey.title,
      description: survey.description,
      type: "SURVEY",
      priority: survey.priority,
      theme: {},
      steps: survey.questions,
      targetingRules: survey.targetingRules,
      frequencyRules: survey.frequencyRules as Record<string, unknown>,
      scheduleRules: survey.scheduleRules as Record<string, unknown>,
      metadata: {
        ...survey.metadata,
        surveyId: survey._id.toString(),
        sdkIntegrationId: survey.sdkIntegrationId,
      },
      eligibility,
    };
  }

  private extractNpsScore(
    survey: ISurveyDocument,
    answers: Record<string, unknown> | Array<any>,
  ): number | null {
    const npsQuestion = survey.questions.find(
      (question) => question.type === "NPS",
    );
    if (!npsQuestion) {
      return null;
    }

    let valueStr: any = undefined;
    if (Array.isArray(answers)) {
      const found = answers.find((ans) => ans?.questionId === npsQuestion.id);
      if (found) {
        valueStr = found.value;
      }
    } else if (answers && typeof answers === "object") {
      valueStr = answers[npsQuestion.id];
    }

    const value =
      valueStr !== undefined && valueStr !== null ? Number(valueStr) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  private categorizeNps(score: number | null): NpsCategory {
    if (score == null) {
      return "NONE";
    }

    if (score >= 9) {
      return "PROMOTER";
    }

    if (score >= 7) {
      return "PASSIVE";
    }

    return "DETRACTOR";
  }

  private buildTrend(
    responses: Array<{ submittedAt: Date; category: NpsCategory }>,
    bucket: "week" | "month",
  ) {
    const groups = new Map<
      string,
      { total: number; promoters: number; detractors: number }
    >();

    responses.forEach((response) => {
      const date = response.submittedAt;
      const key =
        bucket === "month"
          ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
          : `${date.getUTCFullYear()}-W${String(this.weekOfYear(date)).padStart(2, "0")}`;
      const current = groups.get(key) ?? {
        total: 0,
        promoters: 0,
        detractors: 0,
      };
      current.total += 1;
      current.promoters += response.category === "PROMOTER" ? 1 : 0;
      current.detractors += response.category === "DETRACTOR" ? 1 : 0;
      groups.set(key, current);
    });

    return [...groups.entries()].map(([period, value]) => ({
      period,
      responses: value.total,
      nps:
        value.total > 0
          ? ((value.promoters - value.detractors) / value.total) * 100
          : 0,
    }));
  }

  private weekOfYear(date: Date): number {
    const firstDay = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const dayOffset = Math.floor(
      (date.getTime() - firstDay.getTime()) / 86400000,
    );
    return Math.ceil((dayOffset + firstDay.getUTCDay() + 1) / 7);
  }
}

export default new SurveyService();
