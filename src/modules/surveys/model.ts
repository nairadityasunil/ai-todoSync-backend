import { Schema, model, type Document } from "mongoose";
import {
  GUIDE_PRIORITIES,
  GUIDE_STATUSES,
  SURVEY_QUESTION_TYPES,
  type FrequencyRules,
  type GuidePriority,
  type GuideStatus,
  type NpsCategory,
  type ScheduleRules,
  type SurveyQuestion,
  type TargetingRuleGroup,
} from "../engagement/types.js";

export interface ISurvey {
  tenantId: string;
  sdkIntegrationId: string;
  title: string;
  description?: string;
  status: GuideStatus;
  priority: GuidePriority;
  questions: SurveyQuestion[];
  targetingRules?: TargetingRuleGroup | null;
  triggerRules?: TargetingRuleGroup | null;
  frequencyRules: FrequencyRules;
  scheduleRules: ScheduleRules;
  analytics: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISurveyDocument extends ISurvey, Document {}

const surveyQuestionSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: SURVEY_QUESTION_TYPES, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 10 },
    branchConditions: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const surveySchema = new Schema<ISurveyDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    sdkIntegrationId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    status: {
      type: String,
      enum: GUIDE_STATUSES,
      default: "DRAFT",
      index: true,
    },
    priority: {
      type: String,
      enum: GUIDE_PRIORITIES,
      default: "MEDIUM",
      index: true,
    },
    questions: { type: [surveyQuestionSchema], default: [] },
    targetingRules: { type: Schema.Types.Mixed, default: null },
    triggerRules: { type: Schema.Types.Mixed, default: null },
    frequencyRules: {
      type: Schema.Types.Mixed,
      default: { showOnceEver: false, showOncePerSession: true },
    },
    scheduleRules: { type: Schema.Types.Mixed, default: {} },
    analytics: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: String, required: true, index: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

surveySchema.index({ tenantId: 1, status: 1, priority: 1 });
surveySchema.index({ sdkIntegrationId: 1, status: 1, priority: 1 });

export interface ISurveyAnswer {
  questionId: string;
  questionTitle: string;
  questionType: string;
  value: unknown;
}

export interface ISurveyResponse {
  surveyId: string;
  userId?: string;
  tenantId: string;
  sdkIntegrationId: string;
  sessionId?: string;
  answers: ISurveyAnswer[] | Record<string, unknown>;
  npsScore?: number | null;
  category: NpsCategory;
  metadata: Record<string, unknown>;
  submittedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISurveyResponseDocument extends ISurveyResponse, Document {}

const surveyAnswerSchema = new Schema(
  {
    questionId: { type: String, required: true },
    questionTitle: { type: String, required: true },
    questionType: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const surveyResponseSchema = new Schema<ISurveyResponseDocument>(
  {
    surveyId: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    tenantId: { type: String, required: true, index: true },
    sdkIntegrationId: { type: String, required: true, index: true },
    sessionId: { type: String, index: true },
    answers: { type: [surveyAnswerSchema], default: [] },
    npsScore: { type: Number, default: null },
    category: {
      type: String,
      enum: ["PROMOTER", "PASSIVE", "DETRACTOR", "NONE"],
      default: "NONE",
      index: true,
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    submittedAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: true },
);

surveyResponseSchema.index({ tenantId: 1, surveyId: 1, submittedAt: -1 });
surveyResponseSchema.index({ tenantId: 1, category: 1, submittedAt: -1 });
surveyResponseSchema.index({ sdkIntegrationId: 1, surveyId: 1, submittedAt: -1 });
surveyResponseSchema.index({ sdkIntegrationId: 1, category: 1, submittedAt: -1 });
surveyResponseSchema.index(
  { surveyId: 1, "metadata.idempotencyKey": 1 },
  { sparse: true },
);

export const SurveyModel = model<ISurveyDocument>("Survey", surveySchema);
export const SurveyResponseModel = model<ISurveyResponseDocument>(
  "SurveyResponse",
  surveyResponseSchema,
);
