import type { Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import { userIdOf } from "../agents/http.js";
import { closeTask } from "../telemetry/automation.service.js";
import { AutomationLinkModel } from "../telemetry/model.js";
import { MATH_OPS } from "./engine.js";
import {
  CohortModel,
  DashboardModel,
  InsightModel,
  MetricAlertModel,
  type IDashboardPanel,
  type InsightKind,
  type Visualization,
} from "./model.js";
import {
  computeCohort,
  evaluateOne,
  listIntegrations,
  metricOptions,
  ownIntegration,
  runQuery,
  sanitizeAlertMetric,
  sanitizeCohort,
  schema,
} from "./service.js";

const KINDS: InsightKind[] = ["trends", "funnel", "retention", "paths"];
const VIZ: Visualization[] = ["line", "bar", "number", "table"];
const WIDTHS = [3, 4, 6, 8, 12];
const ALERT_WINDOWS = [1, 6, 24, 168];
const RANGES = ["1h", "24h", "7d", "14d", "30d", "90d", "180d"];
const REFRESH = [0, 60, 300, 900];

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const required = (v: unknown, max: number, what: string): string => {
  const t = text(v, max + 1);
  if (!t) throw new AppError(400, `${what} is required`, "BAD_REQUEST");
  if (t.length > max)
    throw new AppError(
      400,
      `${what} can be at most ${max} characters`,
      "BAD_REQUEST",
    );
  return t;
};
const idParam = (req: AuthenticatedRequest, name: string): string => {
  const v = String((req.params as Record<string, string>)[name] ?? "");
  if (!Types.ObjectId.isValid(v))
    throw new AppError(404, "Not found", "NOT_FOUND");
  return v;
};
const body = (req: AuthenticatedRequest) =>
  (req.body ?? {}) as Record<string, unknown>;
const sourceOf = (v: unknown): "events" | "pristine" =>
  v === "pristine" ? "pristine" : "events";
const serialize = <T extends { _id: unknown }>(doc: T) => ({
  ...doc,
  id: String(doc._id),
});

/** Checks a saved insight's query by running it once, so broken insights cannot be saved. */
async function validatedInsight(userId: string, b: Record<string, unknown>) {
  const kind = KINDS.includes(b.kind as InsightKind)
    ? (b.kind as InsightKind)
    : null;
  if (!kind)
    throw new AppError(
      400,
      "Choose an insight type: trends, funnel, retention or paths",
      "BAD_REQUEST",
    );
  const source = sourceOf(b.source);
  const query = (
    b.query && typeof b.query === "object" ? b.query : {}
  ) as Record<string, unknown>;
  const integrationId =
    source === "events"
      ? (await ownIntegration(userId, b.integrationId)).id
      : null;
  await runQuery({ userId, kind, source, integrationId, query, range: "24h" });
  return {
    name: required(b.name, 120, "Name"),
    description: text(b.description, 500) ?? "",
    kind,
    source,
    integrationId,
    query,
    visualization: VIZ.includes(b.visualization as Visualization)
      ? (b.visualization as Visualization)
      : kind === "trends"
        ? "line"
        : "table",
  };
}

function sanitizePanels(
  raw: unknown,
  ownedInsightIds: Set<string>,
): IDashboardPanel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 40)
    .map((p) => p as Record<string, unknown>)
    .filter(
      (p) =>
        typeof p.insightId === "string" && ownedInsightIds.has(p.insightId),
    )
    .map((p, i) => ({
      id: text(p.id, 40) ?? `p${Date.now().toString(36)}${i}`,
      insightId: String(p.insightId),
      title: text(p.title, 120) ?? null,
      width: (WIDTHS.includes(Number(p.width))
        ? Number(p.width)
        : 6) as IDashboardPanel["width"],
      visualization: VIZ.includes(p.visualization as Visualization)
        ? (p.visualization as Visualization)
        : null,
    }));
}

class InsightsController {
  /* ----------------------------- Sources ----------------------------- */
  public integrations = async (req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: {
        integrations: await listIntegrations(userIdOf(req)),
        metrics: metricOptions(),
        mathOps: MATH_OPS,
      },
    });
  };

  public schema = async (req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: await schema(userIdOf(req), String(req.query.integrationId ?? "")),
    });
  };

  public query = async (req: AuthenticatedRequest, res: Response) => {
    const b = body(req);
    const kind = KINDS.includes(b.kind as InsightKind)
      ? (b.kind as InsightKind)
      : null;
    if (!kind)
      throw new AppError(
        400,
        "Choose an insight type: trends, funnel, retention or paths",
        "BAD_REQUEST",
      );
    const data = await runQuery({
      userId: userIdOf(req),
      kind,
      source: sourceOf(b.source),
      integrationId: text(b.integrationId, 40) ?? null,
      query: (b.query && typeof b.query === "object" ? b.query : {}) as Record<
        string,
        unknown
      >,
      range: b.range,
      from: b.from,
      to: b.to,
    });
    res.json({ success: true, data });
  };

  /* ----------------------------- Insights ---------------------------- */
  public listInsights = async (req: AuthenticatedRequest, res: Response) => {
    const rows = await InsightModel.find({ ownerId: userIdOf(req) })
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    res.json({ success: true, data: rows.map(serialize) });
  };

  public createInsight = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await InsightModel.create({
      ...(await validatedInsight(userId, body(req))),
      ownerId: userId,
    });
    res.status(201).json({ success: true, data: serialize(doc.toObject()) });
  };

  public updateInsight = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await InsightModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userId,
    });
    if (!doc) throw new AppError(404, "Insight not found", "NOT_FOUND");
    const merged = { ...doc.toObject(), ...body(req) } as Record<
      string,
      unknown
    >;
    doc.set(await validatedInsight(userId, merged));
    await doc.save();
    res.json({ success: true, data: serialize(doc.toObject()) });
  };

  public deleteInsight = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const id = idParam(req, "id");
    const doc = await InsightModel.findOneAndDelete({
      _id: id,
      ownerId: userId,
    });
    if (!doc) throw new AppError(404, "Insight not found", "NOT_FOUND");
    // Panels that showed it are removed from the person's dashboards.
    const dashboards = await DashboardModel.find({ ownerId: userId });
    for (const d of dashboards) {
      const kept = (d.panels ?? []).filter((p) => p.insightId !== id);
      if (kept.length !== (d.panels ?? []).length) {
        d.panels = kept;
        d.markModified("panels");
        await d.save();
      }
    }
    res.json({ success: true, data: { deleted: true } });
  };

  public runInsight = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await InsightModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userId,
    }).lean();
    if (!doc) throw new AppError(404, "Insight not found", "NOT_FOUND");
    const b = body(req);
    const data = await runQuery({
      userId,
      kind: doc.kind,
      source: doc.source,
      integrationId: doc.integrationId,
      query: doc.query,
      range: b.range,
      from: b.from,
      to: b.to,
    });
    res.json({
      success: true,
      data: { insight: serialize(doc), result: data },
    });
  };

  /* ---------------------------- Dashboards --------------------------- */
  private owned = async (userId: string) =>
    new Set(
      (await InsightModel.find({ ownerId: userId }).select("_id").lean()).map(
        (i) => String(i._id),
      ),
    );

  public listDashboards = async (req: AuthenticatedRequest, res: Response) => {
    const rows = await DashboardModel.find({ ownerId: userIdOf(req) })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data: rows.map(serialize) });
  };

  public getDashboard = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await DashboardModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userId,
    }).lean();
    if (!doc) throw new AppError(404, "Dashboard not found", "NOT_FOUND");
    const insights = await InsightModel.find({
      _id: { $in: (doc.panels ?? []).map((p) => p.insightId) },
      ownerId: userId,
    }).lean();
    res.json({
      success: true,
      data: { ...serialize(doc), insights: insights.map(serialize) },
    });
  };

  private dashboardFields = async (
    userId: string,
    b: Record<string, unknown>,
    partial: boolean,
  ) => {
    const out: Record<string, unknown> = {};
    if (!partial || b.name !== undefined)
      out.name = required(b.name, 120, "Name");
    if (b.description !== undefined)
      out.description = text(b.description, 500) ?? "";
    if (b.panels !== undefined)
      out.panels = sanitizePanels(b.panels, await this.owned(userId));
    if (b.range !== undefined) {
      if (!RANGES.includes(String(b.range)))
        throw new AppError(
          400,
          `Range must be one of ${RANGES.join(", ")}`,
          "BAD_REQUEST",
        );
      out.range = String(b.range);
    }
    if (b.refreshSeconds !== undefined) {
      if (!REFRESH.includes(Number(b.refreshSeconds)))
        throw new AppError(
          400,
          "Refresh must be off, 1, 5 or 15 minutes",
          "BAD_REQUEST",
        );
      out.refreshSeconds = Number(b.refreshSeconds);
    }
    return out;
  };

  public createDashboard = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await DashboardModel.create({
      panels: [],
      range: "7d",
      refreshSeconds: 0,
      ...(await this.dashboardFields(userId, body(req), false)),
      ownerId: userId,
    });
    res.status(201).json({ success: true, data: serialize(doc.toObject()) });
  };

  public updateDashboard = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await DashboardModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userId,
    });
    if (!doc) throw new AppError(404, "Dashboard not found", "NOT_FOUND");
    doc.set(await this.dashboardFields(userId, body(req), true));
    doc.markModified("panels");
    await doc.save();
    res.json({ success: true, data: serialize(doc.toObject()) });
  };

  public deleteDashboard = async (req: AuthenticatedRequest, res: Response) => {
    const doc = await DashboardModel.findOneAndDelete({
      _id: idParam(req, "id"),
      ownerId: userIdOf(req),
    });
    if (!doc) throw new AppError(404, "Dashboard not found", "NOT_FOUND");
    res.json({ success: true, data: { deleted: true } });
  };

  /* ------------------------------ Cohorts ---------------------------- */
  public listCohorts = async (req: AuthenticatedRequest, res: Response) => {
    const filter: Record<string, unknown> = { ownerId: userIdOf(req) };
    if (text(req.query.integrationId, 40))
      filter.integrationId = text(req.query.integrationId, 40);
    const rows = await CohortModel.find(filter)
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data: rows.map(serialize) });
  };

  public createCohort = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const b = body(req);
    const integration = await ownIntegration(userId, b.integrationId);
    const definition = sanitizeCohort(b.definition);
    const { members } = await computeCohort(integration.id, definition);
    const doc = await CohortModel.create({
      ownerId: userId,
      integrationId: integration.id,
      name: required(b.name, 120, "Name"),
      description: text(b.description, 500) ?? "",
      definition: definition as unknown as Record<string, unknown>,
      lastCount: members.length,
      lastComputedAt: new Date(),
    });
    res.status(201).json({ success: true, data: serialize(doc.toObject()) });
  };

  public updateCohort = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await CohortModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userId,
    });
    if (!doc) throw new AppError(404, "Cohort not found", "NOT_FOUND");
    const b = body(req);
    if (b.name !== undefined) doc.name = required(b.name, 120, "Name");
    if (b.description !== undefined)
      doc.description = text(b.description, 500) ?? "";
    if (b.definition !== undefined) {
      doc.definition = sanitizeCohort(b.definition) as never;
      doc.markModified("definition");
    }
    const { members } = await computeCohort(
      doc.integrationId,
      doc.definition as never,
    );
    doc.lastCount = members.length;
    doc.lastComputedAt = new Date();
    await doc.save();
    res.json({ success: true, data: serialize(doc.toObject()) });
  };

  public deleteCohort = async (req: AuthenticatedRequest, res: Response) => {
    const doc = await CohortModel.findOneAndDelete({
      _id: idParam(req, "id"),
      ownerId: userIdOf(req),
    });
    if (!doc) throw new AppError(404, "Cohort not found", "NOT_FOUND");
    res.json({ success: true, data: { deleted: true } });
  };

  /** Who is in a cohort now. A preview works without saving (POST with a definition). */
  public cohortMembers = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    let integrationId: string;
    let definition;
    if (req.method === "POST") {
      const b = body(req);
      integrationId = (await ownIntegration(userId, b.integrationId)).id;
      definition = sanitizeCohort(b.definition);
    } else {
      const doc = await CohortModel.findOne({
        _id: idParam(req, "id"),
        ownerId: userId,
      });
      if (!doc) throw new AppError(404, "Cohort not found", "NOT_FOUND");
      await ownIntegration(userId, doc.integrationId);
      integrationId = doc.integrationId;
      definition = sanitizeCohort(doc.definition);
    }
    const { members, truncated } = await computeCohort(
      integrationId,
      definition,
    );
    res.json({
      success: true,
      data: { count: members.length, sample: members.slice(0, 100), truncated },
    });
  };

  /* ------------------------------ Alerts ----------------------------- */
  private alertFields = async (
    userId: string,
    b: Record<string, unknown>,
    current?: Record<string, unknown>,
  ) => {
    const merged = { ...(current ?? {}), ...b };
    const source = sourceOf(merged.source);
    const integrationId =
      source === "events"
        ? (await ownIntegration(userId, merged.integrationId)).id
        : null;
    const condition = ["above", "below", "change_up", "change_down"].includes(
      String(merged.condition),
    )
      ? String(merged.condition)
      : null;
    if (!condition)
      throw new AppError(
        400,
        "Choose when the alert fires: above, below, up by or down by",
        "BAD_REQUEST",
      );
    const threshold = Number(merged.threshold);
    if (!Number.isFinite(threshold) || threshold < 0)
      throw new AppError(
        400,
        "The threshold must be a number of 0 or more",
        "BAD_REQUEST",
      );
    if (condition.startsWith("change") && (threshold <= 0 || threshold > 1000))
      throw new AppError(
        400,
        "A change threshold is a percentage between 1 and 1000",
        "BAD_REQUEST",
      );
    const windowHours = Number(merged.windowHours);
    if (!ALERT_WINDOWS.includes(windowHours))
      throw new AppError(
        400,
        "Measure over 1 hour, 6 hours, 24 hours or 7 days",
        "BAD_REQUEST",
      );
    return {
      name: required(merged.name, 120, "Name"),
      source,
      integrationId,
      metric: sanitizeAlertMetric(merged.metric, source) as unknown as Record<
        string,
        unknown
      >,
      condition: condition as "above" | "below" | "change_up" | "change_down",
      threshold,
      windowHours,
      enabled: merged.enabled !== false,
    };
  };

  public listAlerts = async (req: AuthenticatedRequest, res: Response) => {
    const rows = await MetricAlertModel.find({ ownerId: userIdOf(req) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const links = await AutomationLinkModel.find({
      key: { $in: rows.map((r) => `metric_alert:${r._id}`) },
      state: "open",
    })
      .select("key taskId projectId")
      .lean();
    const taskByKey = new Map(
      links.map((l) => [
        l.key,
        {
          taskId: String(l.taskId),
          projectId: l.projectId ? String(l.projectId) : null,
        },
      ]),
    );
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...serialize(r),
        openTask: taskByKey.get(`metric_alert:${r._id}`) ?? null,
      })),
    });
  };

  public createAlert = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await MetricAlertModel.create({
      ...(await this.alertFields(userId, body(req))),
      ownerId: userId,
      state: "ok",
    });
    // Checked right away, so the list shows a real value instead of waiting five minutes.
    await evaluateOne(doc);
    res.status(201).json({ success: true, data: serialize(doc.toObject()) });
  };

  public updateAlert = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const doc = await MetricAlertModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userId,
    });
    if (!doc) throw new AppError(404, "Alert not found", "NOT_FOUND");
    doc.set(
      await this.alertFields(
        userId,
        body(req),
        doc.toObject() as unknown as Record<string, unknown>,
      ),
    );
    doc.markModified("metric");
    await doc.save();
    if (doc.enabled) await evaluateOne(doc);
    else
      await this.closeAlertTask(String(doc._id), "the alert was turned off.");
    res.json({ success: true, data: serialize(doc.toObject()) });
  };

  private closeAlertTask = async (id: string, reason: string) => {
    const open = await AutomationLinkModel.findOne({
      key: `metric_alert:${id}`,
      state: "open",
    });
    if (open) await closeTask(open, reason);
  };

  public deleteAlert = async (req: AuthenticatedRequest, res: Response) => {
    const doc = await MetricAlertModel.findOneAndDelete({
      _id: idParam(req, "id"),
      ownerId: userIdOf(req),
    });
    if (!doc) throw new AppError(404, "Alert not found", "NOT_FOUND");
    await this.closeAlertTask(String(doc._id), "the alert was deleted.");
    res.json({ success: true, data: { deleted: true } });
  };

  public checkAlert = async (req: AuthenticatedRequest, res: Response) => {
    const doc = await MetricAlertModel.findOne({
      _id: idParam(req, "id"),
      ownerId: userIdOf(req),
    });
    if (!doc) throw new AppError(404, "Alert not found", "NOT_FOUND");
    const outcome = await evaluateOne(doc);
    res.json({
      success: true,
      data: { outcome, alert: serialize(doc.toObject()) },
    });
  };
}

export default new InsightsController();
