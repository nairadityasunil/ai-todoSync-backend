import AnalyticsEventRegistryModel from "../analytics/models/analytics-event-registry.model.js";
import AnalyticsKeyModel from "../analytics/models/analytics-key.model.js";
import AnalyticsLogModel from "../analytics/models/analytics-log.model.js";
import { AppError } from "../../utils/app-error.js";
import { GuideExposureModel } from "../engagement/model.js";
import type {
  FrequencyRules,
  GuideEligibilityResult,
  ScheduleRules,
  TargetingCondition,
  TargetingRuleGroup,
  TargetingRuntimeContext,
} from "../engagement/types.js";
import type {
  CreateTargetingSegmentDto,
  UpdateTargetingSegmentDto,
} from "./dtos.js";
import targetingRepository from "./repository.js";

interface EvaluationInput {
  rules?: TargetingRuleGroup | null;
  context: TargetingRuntimeContext;
  guideId?: string;
  frequencyRules?: FrequencyRules;
  scheduleRules?: ScheduleRules;
}

interface ConditionEvaluation {
  matched: boolean;
  reason: string;
}

const MAX_REGEX_LENGTH = 200;
const MAX_REGEX_INPUT_LENGTH = 2048;
/** A quantified group that itself contains a quantifier, e.g. (a+)+ or (x*)*. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

const PRIORITY_INDEX: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

class TargetingService {
  public listSegments(tenantId: string) {
    return targetingRepository.listSegments(tenantId);
  }

  public getSegment(tenantId: string, segmentId: string) {
    return targetingRepository.getSegment(tenantId, segmentId);
  }

  public createSegment(
    tenantId: string,
    createdBy: string,
    dto: CreateTargetingSegmentDto,
  ) {
    return targetingRepository.createSegment(tenantId, createdBy, dto);
  }

  public async updateSegment(
    tenantId: string,
    segmentId: string,
    updatedBy: string,
    dto: UpdateTargetingSegmentDto,
  ) {
    const segment = await targetingRepository.updateSegment(
      tenantId,
      segmentId,
      updatedBy,
      dto,
    );

    if (!segment) {
      throw new AppError(404, "Targeting segment not found", "NOT_FOUND");
    }

    return segment;
  }

  public async deleteSegment(tenantId: string, segmentId: string) {
    const result = await targetingRepository.deleteSegment(tenantId, segmentId);

    if (result.deletedCount === 0) {
      throw new AppError(404, "Targeting segment not found", "NOT_FOUND");
    }
  }

  public async evaluate(
    input: EvaluationInput,
  ): Promise<GuideEligibilityResult> {
    const reasons: string[] = [];
    const matchedConditions: string[] = [];
    const failedConditions: string[] = [];
    const now = this.toDate(input.context.now) ?? new Date();

    const scheduleResult = this.evaluateSchedule(input.scheduleRules, now);
    if (!scheduleResult.matched) {
      return {
        eligible: false,
        reasons: [scheduleResult.reason],
        matchedConditions,
        failedConditions: ["schedule"],
      };
    }

    if (input.guideId && input.frequencyRules) {
      const frequencyResult = await this.evaluateFrequency({
        tenantId: input.context.tenantId,
        sdkIntegrationId: input.context.sdkIntegrationId,
        guideId: input.guideId,
        userId: input.context.userId,
        sessionId: input.context.sessionId,
        rules: input.frequencyRules,
        now,
        forceShowCompleted: input.context.forceShowCompleted,
      });

      if (!frequencyResult.matched) {
        return {
          eligible: false,
          reasons: [frequencyResult.reason],
          matchedConditions,
          failedConditions: ["frequency"],
        };
      }
    }

    if (!input.rules) {
      return {
        eligible: true,
        reasons: ["No targeting rules"],
        matchedConditions,
        failedConditions,
      };
    }

    const result = await this.evaluateGroup(input.rules, input.context);
    result.matchedConditions.forEach((condition) =>
      matchedConditions.push(condition),
    );
    result.failedConditions.forEach((condition) =>
      failedConditions.push(condition),
    );
    reasons.push(...result.reasons);

    return {
      eligible: result.eligible,
      reasons,
      matchedConditions,
      failedConditions,
    };
  }

  public comparePriority(left: string, right: string): number {
    return (PRIORITY_INDEX[right] ?? 0) - (PRIORITY_INDEX[left] ?? 0);
  }

  private async evaluateGroup(
    group: TargetingRuleGroup,
    context: TargetingRuntimeContext,
  ): Promise<GuideEligibilityResult> {
    const conditionResults = await Promise.all(
      (group.conditions ?? []).map(async (condition) => ({
        id: condition.id,
        ...(await this.evaluateCondition(condition, context)),
      })),
    );
    const groupResults = await Promise.all(
      (group.groups ?? []).map((nested) => this.evaluateGroup(nested, context)),
    );

    const allResults = [
      ...conditionResults.map((result) => result.matched),
      ...groupResults.map((result) => result.eligible),
    ];

    const eligible =
      allResults.length === 0
        ? true
        : group.operator === "AND"
          ? allResults.every(Boolean)
          : allResults.some(Boolean);

    const matchedConditions = [
      ...conditionResults
        .filter((result) => result.matched)
        .map((result) => result.id),
      ...groupResults.flatMap((result) => result.matchedConditions),
    ];
    const failedConditions = [
      ...conditionResults
        .filter((result) => !result.matched)
        .map((result) => result.id),
      ...groupResults.flatMap((result) => result.failedConditions),
    ];
    const reasons = [
      ...conditionResults.map((result) => result.reason),
      ...groupResults.flatMap((result) => result.reasons),
    ];

    return { eligible, matchedConditions, failedConditions, reasons };
  }

  private async evaluateCondition(
    condition: TargetingCondition,
    context: TargetingRuntimeContext,
  ): Promise<ConditionEvaluation> {
    switch (condition.type) {
      case "URL_EQUALS":
        return this.stringCondition(condition, context.url, "URL equals");
      case "URL_CONTAINS":
        return this.containsCondition(condition, context.url, "URL contains");
      case "URL_REGEX":
        return this.regexCondition(condition, context.url, "URL regex");
      case "REFERRER_EQUALS":
        return this.stringCondition(
          condition,
          context.referrer,
          "Referrer equals",
        );
      case "REFERRER_CONTAINS":
        return this.containsCondition(
          condition,
          context.referrer,
          "Referrer contains",
        );
      case "ROLE_EQUALS":
        return this.stringCondition(condition, context.role, "Role equals");
      case "PLAN_EQUALS":
        return this.stringCondition(condition, context.plan, "Plan equals");
      case "ACCOUNT_AGE":
        return this.numberCondition(
          condition,
          this.accountAgeDays(context.accountCreatedAt),
          "Account age",
        );
      case "TENANT_EQUALS":
        return this.stringCondition(
          condition,
          context.tenantId,
          "Tenant equals",
        );
      case "SESSION_DURATION":
        return this.numberCondition(
          condition,
          context.session?.durationSeconds,
          "Session duration",
        );
      case "SESSION_COUNT":
        return this.numberCondition(
          condition,
          context.session?.count,
          "Session count",
        );
      case "ENGAGEMENT_SCORE":
        return this.numberCondition(
          condition,
          context.session?.engagementScore,
          "Engagement score",
        );
      case "COMPLETED_WORKFLOW":
        return this.arrayContainsCondition(
          condition,
          context.workflow?.completed,
          "Completed workflow",
        );
      case "EVENT_TRIGGERED":
      case "EVENT_NOT_TRIGGERED":
      case "RAGE_CLICK_COUNT":
      case "VISITED_PAGE":
      case "ABANDONED_FORM":
        return this.behaviorCondition(condition, context);
      case "SHOW_ONCE":
      case "SHOW_EVERY_X_DAYS":
      case "COOLDOWN":
      case "TIME_WINDOW":
        return {
          matched: true,
          reason: `${condition.type} handled by frequency engine`,
        };
      case "EXIT_INTENT":
        return {
          matched: context.eventName === "exit_intent",
          reason: `Exit intent: ${context.eventName === "exit_intent" ? "matched" : "failed"}`,
        };
      case "IDLE_TIMEOUT":
        return {
          matched: context.eventName === "idle_timeout",
          reason: `Idle timeout: ${context.eventName === "idle_timeout" ? "matched" : "failed"}`,
        };
      default:
        return {
          matched: false,
          reason: `Unsupported condition ${condition.type}`,
        };
    }
  }

  private stringCondition(
    condition: TargetingCondition,
    actual: string | undefined,
    label: string,
  ): ConditionEvaluation {
    const expected = String(condition.value ?? "");
    const matched = actual === expected;
    return { matched, reason: `${label}: ${matched ? "matched" : "failed"}` };
  }

  private containsCondition(
    condition: TargetingCondition,
    actual: string | undefined,
    label: string,
  ): ConditionEvaluation {
    const expected = String(condition.value ?? "");
    const matched = Boolean(actual?.includes(expected));
    return { matched, reason: `${label}: ${matched ? "matched" : "failed"}` };
  }

  private regexCondition(
    condition: TargetingCondition,
    actual: string | undefined,
    label: string,
  ): ConditionEvaluation {
    const pattern = String(condition.value ?? "");
    // Patterns are admin-authored but run on the shared server for every
    // page view, so refuse the shapes that cause catastrophic backtracking.
    if (pattern.length > MAX_REGEX_LENGTH || NESTED_QUANTIFIER.test(pattern)) {
      return { matched: false, reason: `${label}: unsupported regex` };
    }
    try {
      const matched = new RegExp(pattern).test(
        (actual ?? "").slice(0, MAX_REGEX_INPUT_LENGTH),
      );
      return { matched, reason: `${label}: ${matched ? "matched" : "failed"}` };
    } catch {
      return { matched: false, reason: `${label}: invalid regex` };
    }
  }

  private arrayContainsCondition(
    condition: TargetingCondition,
    actual: string[] | undefined,
    label: string,
  ): ConditionEvaluation {
    const expected = String(condition.value ?? "");
    const matched = Boolean(actual?.includes(expected));
    return { matched, reason: `${label}: ${matched ? "matched" : "failed"}` };
  }

  private numberCondition(
    condition: TargetingCondition,
    actual: number | undefined,
    label: string,
  ): ConditionEvaluation {
    if (typeof actual !== "number") {
      return { matched: false, reason: `${label}: unavailable` };
    }

    const expected = Number(condition.value ?? condition.count ?? 0);
    const operator = condition.operator ?? "GREATER_THAN_OR_EQUAL";
    const matched =
      operator === "LESS_THAN"
        ? actual < expected
        : operator === "LESS_THAN_OR_EQUAL"
          ? actual <= expected
          : operator === "GREATER_THAN"
            ? actual > expected
            : operator === "EQUALS"
              ? actual === expected
              : actual >= expected;

    return { matched, reason: `${label}: ${matched ? "matched" : "failed"}` };
  }

  private async behaviorCondition(
    condition: TargetingCondition,
    context: TargetingRuntimeContext,
  ): Promise<ConditionEvaluation> {
    const eventName =
      condition.eventName ??
      (condition.type === "VISITED_PAGE"
        ? "page"
        : condition.type === "RAGE_CLICK_COUNT"
          ? "rage_click"
          : condition.type === "ABANDONED_FORM"
            ? "form_abandoned"
            : String(condition.value ?? ""));
    const count = await this.countEvents({
      tenantId: context.tenantId,
      sdkIntegrationId: context.sdkIntegrationId,
      userId: context.userId,
      sessionId: context.sessionId,
      eventName,
      windowDays: condition.windowDays,
      property: condition.property,
      value: condition.type === "VISITED_PAGE" ? condition.value : undefined,
    });

    if (condition.type === "EVENT_NOT_TRIGGERED") {
      return {
        matched: count === 0,
        reason: `Event not triggered ${eventName}: ${count === 0 ? "matched" : "failed"}`,
      };
    }

    const threshold = condition.count ?? Number(condition.value ?? 1);
    const matched = count >= threshold;
    return {
      matched,
      reason: `Behavior ${eventName}: ${matched ? "matched" : "failed"}`,
    };
  }

  private async countEvents(input: {
    tenantId: string;
    sdkIntegrationId?: string;
    userId?: string;
    sessionId?: string;
    eventName: string;
    windowDays?: number;
    property?: string;
    value?: unknown;
  }): Promise<number> {
    const keys = await AnalyticsKeyModel.find({
      userId: input.tenantId,
      status: "active",
    })
      .select("_id")
      .lean()
      .exec();
    // SDK integration keys store events under the integration's id, so
    // count those as well as legacy analytics keys.
    const apiKeyIds = keys.map((key) => key._id.toString());
    if (input.sdkIntegrationId) {
      apiKeyIds.push(input.sdkIntegrationId);
    }

    if (apiKeyIds.length === 0) {
      return 0;
    }

    const events = await AnalyticsEventRegistryModel.find({
      apiKeyId: { $in: apiKeyIds },
      eventName: input.eventName,
    })
      .select("_id")
      .lean()
      .exec();
    const eventRefs = events.map((event) => event._id.toString());

    if (eventRefs.length === 0) {
      return 0;
    }

    const createdAt =
      typeof input.windowDays === "number" && input.windowDays > 0
        ? { $gte: new Date(Date.now() - input.windowDays * 86400000) }
        : undefined;
    const filter: Record<string, unknown> = {
      apiKeyId: { $in: apiKeyIds },
      eventRef: { $in: eventRefs },
      ...(input.userId ? { userIdentifier: input.userId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
    };

    if (input.property && input.value !== undefined) {
      filter[`payload.${input.property}`] = input.value;
    }

    if (!input.property && input.value !== undefined) {
      filter.$or = [
        { "payload.url": input.value },
        { "payload.properties.url": input.value },
      ];
    }

    return AnalyticsLogModel.countDocuments(filter).exec();
  }

  private evaluateSchedule(
    rules: ScheduleRules | undefined,
    now: Date,
  ): ConditionEvaluation {
    if (!rules) {
      return { matched: true, reason: "No schedule rules" };
    }

    const startsAt = this.toDate(rules.startsAt);
    const endsAt = this.toDate(rules.endsAt);

    if (startsAt && now < startsAt) {
      return { matched: false, reason: "Guide schedule has not started" };
    }

    if (endsAt && now > endsAt) {
      return { matched: false, reason: "Guide schedule has ended" };
    }

    return { matched: true, reason: "Schedule matched" };
  }

  private async evaluateFrequency(input: {
    tenantId: string;
    sdkIntegrationId?: string;
    guideId: string;
    userId?: string;
    sessionId?: string;
    rules: FrequencyRules;
    now: Date;
    forceShowCompleted?: boolean;
  }): Promise<ConditionEvaluation> {
    const userFilter = {
      tenantId: input.tenantId,
      ...(input.sdkIntegrationId
        ? { sdkIntegrationId: input.sdkIntegrationId }
        : {}),
      guideId: input.guideId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(!input.userId && input.sessionId
        ? { sessionId: input.sessionId }
        : {}),
    };
    const [latestExposure, sessionExposure, exposures] = await Promise.all([
      GuideExposureModel.findOne(userFilter).sort({ lastShownAt: -1 }).exec(),
      input.sessionId
        ? GuideExposureModel.findOne({
            ...userFilter,
            sessionId: input.sessionId,
          }).exec()
        : Promise.resolve(null),
      GuideExposureModel.find(userFilter).select("displayCount").lean().exec(),
    ]);
    const exposure = sessionExposure ?? latestExposure;
    const totalDisplayCount = exposures.reduce(
      (sum, item) => sum + (item.displayCount ?? 0),
      0,
    );

    if (input.forceShowCompleted) {
      return {
        matched: true,
        reason: "Bypassed frequency evaluation due to forceShowCompleted flag",
      };
    }

    if (!exposure) {
      return { matched: true, reason: "No previous exposure" };
    }

    const hasCompletedOrDismissed =
      (latestExposure &&
        ["completed", "dismissed", "abandoned"].includes(
          latestExposure.status,
        )) ||
      (sessionExposure &&
        ["completed", "dismissed", "abandoned"].includes(
          sessionExposure.status,
        ));

    if (hasCompletedOrDismissed) {
      return {
        matched: false,
        reason: `Frequency cap: already completed, dismissed, or abandoned`,
      };
    }

    if (input.rules.showOnceEver && totalDisplayCount > 0) {
      return { matched: false, reason: "Frequency cap: shown once ever" };
    }

    if (
      input.rules.showOncePerSession &&
      input.sessionId &&
      sessionExposure?.displayCount
    ) {
      return {
        matched: false,
        reason: "Frequency cap: shown once per session",
      };
    }

    if (
      typeof input.rules.maxDisplays === "number" &&
      totalDisplayCount >= input.rules.maxDisplays
    ) {
      return { matched: false, reason: "Frequency cap: max displays reached" };
    }

    const lastShownAt =
      latestExposure?.lastShownAt ?? latestExposure?.updatedAt;
    if (!lastShownAt) {
      return { matched: true, reason: "No last shown timestamp" };
    }

    if (
      typeof input.rules.everyXDays === "number" &&
      input.now.getTime() - lastShownAt.getTime() <
        input.rules.everyXDays * 86400000
    ) {
      return { matched: false, reason: "Frequency cap: every X days" };
    }

    if (
      typeof input.rules.cooldownHours === "number" &&
      input.now.getTime() - lastShownAt.getTime() <
        input.rules.cooldownHours * 3600000
    ) {
      return { matched: false, reason: "Frequency cap: cooldown" };
    }

    return { matched: true, reason: "Frequency matched" };
  }

  private accountAgeDays(value: string | Date | undefined): number | undefined {
    const createdAt = this.toDate(value);

    if (!createdAt) {
      return undefined;
    }

    return Math.floor((Date.now() - createdAt.getTime()) / 86400000);
  }

  private toDate(value: string | Date | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}

export default new TargetingService();
