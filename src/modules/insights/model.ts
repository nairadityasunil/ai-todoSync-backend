import mongoose, { Schema, type Document, type Types } from "mongoose";

/**
 * Saved analytics: insights (a query and how to draw it), dashboards (panels
 * of insights), cohorts (saved groups of people) and metric alerts.
 * Everything belongs to the person who made it.
 */

export type InsightKind = "trends" | "funnel" | "retention" | "paths";
export type Visualization = "line" | "bar" | "number" | "table";

export interface IInsight {
  ownerId: Types.ObjectId | string;
  name: string;
  description?: string;
  kind: InsightKind;
  /** Where the data comes from: an SDK integration's events, or Pristine's own metrics. */
  source: "events" | "pristine";
  integrationId?: string | null;
  /** The query, as sent to /query (without the time range). */
  query: Record<string, unknown>;
  visualization: Visualization;
  createdAt: Date;
  updatedAt: Date;
}
export interface IInsightDocument extends IInsight, Document {}

const insightSchema = new Schema<IInsightDocument>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 500 },
    kind: {
      type: String,
      enum: ["trends", "funnel", "retention", "paths"],
      required: true,
    },
    source: { type: String, enum: ["events", "pristine"], default: "events" },
    integrationId: { type: String, default: null },
    query: { type: Schema.Types.Mixed, default: {} },
    visualization: {
      type: String,
      enum: ["line", "bar", "number", "table"],
      default: "line",
    },
  },
  { timestamps: true },
);
export const InsightModel = mongoose.model<IInsightDocument>(
  "Insight",
  insightSchema,
);

export interface IDashboardPanel {
  id: string;
  insightId: string;
  /** Overrides the insight's name on this dashboard. */
  title?: string | null;
  /** Columns out of 12. */
  width: 3 | 4 | 6 | 8 | 12;
  visualization?: Visualization | null;
}

export interface IDashboard {
  ownerId: Types.ObjectId | string;
  name: string;
  description?: string;
  panels: IDashboardPanel[];
  /** Default time range, e.g. "7d". */
  range: string;
  /** Seconds between automatic refreshes; 0 is off. */
  refreshSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface IDashboardDocument extends IDashboard, Document {}

const dashboardSchema = new Schema<IDashboardDocument>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 500 },
    panels: { type: Schema.Types.Mixed, default: [] },
    range: { type: String, default: "7d" },
    refreshSeconds: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const DashboardModel = mongoose.model<IDashboardDocument>(
  "Dashboard",
  dashboardSchema,
);

export interface ICohort {
  ownerId: Types.ObjectId | string;
  integrationId: string;
  name: string;
  description?: string;
  definition: Record<string, unknown>;
  /** Last computed size, for lists. */
  lastCount?: number | null;
  lastComputedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface ICohortDocument extends ICohort, Document {}

const cohortSchema = new Schema<ICohortDocument>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
    integrationId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 500 },
    definition: { type: Schema.Types.Mixed, default: {} },
    lastCount: { type: Number, default: null },
    lastComputedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
export const CohortModel = mongoose.model<ICohortDocument>(
  "Cohort",
  cohortSchema,
);

export interface IMetricAlert {
  ownerId: Types.ObjectId | string;
  name: string;
  source: "events" | "pristine";
  integrationId?: string | null;
  /** One trend series: event (or Pristine metric), math, property, filters. */
  metric: Record<string, unknown>;
  /** Hours the metric is measured over, e.g. the last 24 hours. */
  windowHours: number;
  condition: "above" | "below" | "change_up" | "change_down";
  threshold: number;
  enabled: boolean;
  state: "ok" | "firing" | "no_data";
  lastValue?: number | null;
  lastDetail?: string | null;
  lastEvaluatedAt?: Date | null;
  lastFiredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface IMetricAlertDocument extends IMetricAlert, Document {}

const metricAlertSchema = new Schema<IMetricAlertDocument>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    source: { type: String, enum: ["events", "pristine"], default: "events" },
    integrationId: { type: String, default: null },
    metric: { type: Schema.Types.Mixed, default: {} },
    windowHours: { type: Number, default: 24 },
    condition: {
      type: String,
      enum: ["above", "below", "change_up", "change_down"],
      required: true,
    },
    threshold: { type: Number, required: true },
    enabled: { type: Boolean, default: true },
    state: { type: String, enum: ["ok", "firing", "no_data"], default: "ok" },
    lastValue: { type: Number, default: null },
    lastDetail: { type: String, default: null },
    lastEvaluatedAt: { type: Date, default: null },
    lastFiredAt: { type: Date, default: null },
  },
  { timestamps: true },
);
metricAlertSchema.index({ enabled: 1 });
export const MetricAlertModel = mongoose.model<IMetricAlertDocument>(
  "MetricAlert",
  metricAlertSchema,
);
