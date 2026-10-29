import type { Response } from "express";
import { Types } from "mongoose";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import { toCsv } from "../../utils/csv.js";
import PromptExecutionLogModel from "../prompt/models/prompt-execution-log.model.js";
import WorkspaceMemberModel from "../workspace/models/workspace-member.model.js";
import {
  AgentAlertModel,
  AgentModel,
  AgentWebhookModel,
} from "../agents/model.js";
import { param, requireWorkspace, str, userIdOf } from "../agents/http.js";
import {
  providerIdsFor,
  unknownVendor,
  VENDOR_CATALOG,
  type VendorCategory,
} from "./catalog.js";
import evidenceService, { ALLOWED_EVIDENCE_TYPES } from "./evidence.service.js";
import {
  EVIDENCE_KINDS,
  VENDOR_STATUSES,
  VendorEvidenceModel,
  VendorModel,
  type EvidenceKind,
  type IVendorDocument,
  type VendorStatus,
} from "./model.js";
import {
  missingAnswers,
  QUESTIONS,
  QUESTIONNAIRE_VERSION,
  sanitizeAnswers,
} from "./questionnaire.js";
import {
  nextReviewDate,
  REVIEW_CADENCE_MONTHS,
  type VendorTier,
} from "./risk.js";
import vendorService from "./service.js";

const DAY = 86400000;
const CATEGORIES: VendorCategory[] = [
  "ai_model",
  "ai_assistant",
  "automation",
  "observability",
  "communication",
  "developer_tool",
  "other",
];

const dateOrNull = (value: unknown, field: string): Date | null => {
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new AppError(400, `${field} must be a date`, "BAD_REQUEST");
  return date;
};

const serialize = (vendor: IVendorDocument) => {
  const {
    __v: _v,
    history: _history,
    ...rest
  } = vendor.toObject() as Record<string, unknown>;
  return {
    ...rest,
    id: vendor._id.toString(),
    reviewDue: Boolean(
      vendor.nextReviewAt && vendor.nextReviewAt.getTime() < Date.now(),
    ),
  };
};

/** AI spend per vendor over the last `days`: its models plus its agents' calls. */
async function spendByVendor(
  workspaceId: Types.ObjectId,
  vendors: IVendorDocument[],
  days = 30,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - days * DAY);
  const [byProvider, byAgent, agents] = await Promise.all([
    PromptExecutionLogModel.aggregate<{ _id: string; cost: number }>([
      { $match: { workspaceId, createdAt: { $gte: since } } },
      { $group: { _id: "$provider", cost: { $sum: "$totalCost" } } },
    ]),
    PromptExecutionLogModel.aggregate<{
      _id: Types.ObjectId | null;
      cost: number;
    }>([
      {
        $match: {
          workspaceId,
          createdAt: { $gte: since },
          agentId: { $ne: null },
        },
      },
      { $group: { _id: "$agentId", cost: { $sum: "$totalCost" } } },
    ]),
    AgentModel.find({
      workspaceId,
      vendorId: { $ne: null },
      kind: { $ne: "ai_provider" },
    })
      .select("vendorId")
      .lean(),
  ]);
  const vendorOfAgent = new Map(
    agents.map((a) => [a._id.toString(), String(a.vendorId)]),
  );
  const spend = new Map<string, number>();
  const add = (vendorId: string, cost: number) =>
    spend.set(vendorId, (spend.get(vendorId) ?? 0) + cost);
  for (const vendor of vendors) {
    const ids = providerIdsFor(vendor.key);
    for (const row of byProvider)
      if (ids.includes(row._id)) add(vendor._id.toString(), row.cost);
  }
  for (const row of byAgent) {
    const vendorId = row._id
      ? vendorOfAgent.get(row._id.toString())
      : undefined;
    if (vendorId) add(vendorId, row.cost);
  }
  return spend;
}

class VendorController {
  private load = async (req: AuthenticatedRequest, userId: string) => {
    const workspaceId = await requireWorkspace(req, userId);
    const vendor = await VendorModel.findOne({
      _id: param(req, "vendorId"),
      workspaceId,
    });
    if (!vendor) throw new AppError(404, "Vendor not found", "NOT_FOUND");
    return vendor;
  };

  /** GET /vendors: the register, with usage per vendor. */
  public list = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    await vendorService.syncWorkspace(workspaceId.toString());
    const vendors = await VendorModel.find({ workspaceId })
      .sort({ residualRisk: -1, name: 1 })
      .limit(500)
      .populate("ownerUserId", "name email");
    const ids = vendors.map((v) => v._id);
    const [agentCounts, evidenceCounts, alertCounts, spend] = await Promise.all(
      [
        AgentModel.aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { vendorId: { $in: ids }, status: { $ne: "revoked" } } },
          { $group: { _id: "$vendorId", n: { $sum: 1 } } },
        ]),
        VendorEvidenceModel.aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { vendorId: { $in: ids } } },
          { $group: { _id: "$vendorId", n: { $sum: 1 } } },
        ]),
        AgentAlertModel.aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { vendorId: { $in: ids }, acknowledgedAt: null } },
          { $group: { _id: "$vendorId", n: { $sum: 1 } } },
        ]),
        spendByVendor(workspaceId, vendors),
      ],
    );
    const count = (rows: Array<{ _id: Types.ObjectId; n: number }>) =>
      new Map(rows.map((r) => [r._id.toString(), r.n]));
    const agents = count(agentCounts);
    const evidence = count(evidenceCounts);
    const alerts = count(alertCounts);
    res.json({
      success: true,
      data: vendors.map((vendor) => {
        const id = vendor._id.toString();
        return {
          ...serialize(vendor),
          agentCount: agents.get(id) ?? 0,
          evidenceCount: evidence.get(id) ?? 0,
          openAlerts: alerts.get(id) ?? 0,
          spend30d: Number((spend.get(id) ?? 0).toFixed(4)),
        };
      }),
    });
  };

  /** GET /vendors/catalog: known vendors not yet in the register. */
  public catalog = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const existing = new Set(
      await VendorModel.find({ workspaceId }).distinct("key"),
    );
    res.json({
      success: true,
      data: Object.values(VENDOR_CATALOG).filter((v) => !existing.has(v.key)),
    });
  };

  /** POST /vendors: add a vendor by hand (from the catalog or by name). */
  public create = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = str(body.key);
    const entry =
      key && VENDOR_CATALOG[key]
        ? VENDOR_CATALOG[key]
        : (() => {
            const name = str(body.name);
            if (!name)
              throw new AppError(400, "Name is required", "BAD_REQUEST");
            const category = CATEGORIES.includes(
              body.category as VendorCategory,
            )
              ? (body.category as VendorCategory)
              : "other";
            return {
              ...unknownVendor(name, category),
              website: str(body.website)?.slice(0, 300) ?? "",
            };
          })();
    if (await VendorModel.exists({ workspaceId, key: entry.key }))
      throw new AppError(
        409,
        `${entry.name} is already in the register`,
        "CONFLICT",
      );
    const { vendor } = await vendorService.ensureVendor(
      workspaceId.toString(),
      entry,
      "manual",
    );
    vendor.history[vendor.history.length - 1].by = new Types.ObjectId(userId);
    vendor.history[vendor.history.length - 1].note = "Added by hand";
    await vendor.save();
    await vendorService.recomputeRisk(vendor);
    res.status(201).json({ success: true, data: serialize(vendor) });
  };

  /** GET /vendors/:id: everything about one vendor. */
  public detail = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const vendor = await this.load(req, userId);
    await vendor.populate([
      { path: "ownerUserId", select: "name email" },
      { path: "history.by", select: "name email" },
      { path: "assessmentCompletedBy", select: "name email" },
    ]);
    const [agents, webhooks, evidence, alerts, spend] = await Promise.all([
      AgentModel.find({ vendorId: vendor._id })
        .select(
          "name kind status lastSeenAt callCount scopes projectIds riskLevel",
        )
        .sort({ status: 1, lastSeenAt: -1 })
        .limit(200)
        .lean(),
      AgentWebhookModel.find({ vendorId: vendor._id })
        .select("name url enabled")
        .lean(),
      VendorEvidenceModel.find({ vendorId: vendor._id })
        .sort({ createdAt: -1 })
        .populate("uploadedBy", "name email")
        .lean(),
      AgentAlertModel.find({ vendorId: vendor._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      spendByVendor(vendor.workspaceId as Types.ObjectId, [vendor]),
    ]);
    const answers = (vendor.answers ?? {}) as Record<string, string>;
    res.json({
      success: true,
      data: {
        ...serialize(vendor),
        history: [...vendor.history].reverse(),
        agents: agents.map((a) => ({ ...a, id: a._id.toString() })),
        webhooks: webhooks.map((w) => ({
          id: w._id.toString(),
          name: w.name,
          url: w.url,
          enabled: w.enabled,
        })),
        evidence: evidence.map((e) => ({
          ...e,
          id: e._id.toString(),
          fileId: undefined,
        })),
        alerts: alerts.map((a) => ({ ...a, id: a._id.toString() })),
        spend30d: Number((spend.get(vendor._id.toString()) ?? 0).toFixed(4)),
        questionnaire: {
          version: QUESTIONNAIRE_VERSION,
          questions: QUESTIONS,
          missing: missingAnswers(answers),
        },
        reviewCadenceMonths: REVIEW_CADENCE_MONTHS[vendor.tier],
      },
    });
  };

  /** PATCH /vendors/:id: profile, owner, tier, contract dates, sub-processor listing. */
  public update = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const vendor = await this.load(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changed: string[] = [];
    const text = (
      field: "name" | "website" | "purpose" | "dataLocation" | "notes",
      max: number,
    ) => {
      if (body[field] === undefined) return;
      const value =
        body[field] === null
          ? null
          : String(body[field]).trim().slice(0, max) || null;
      if (field === "name" && !value)
        throw new AppError(400, "Name is required", "BAD_REQUEST");
      if (field === "website" && value && !/^https?:\/\//i.test(value))
        throw new AppError(
          400,
          "Website must start with https://",
          "BAD_REQUEST",
        );
      vendor.set(field, value);
      changed.push(field);
    };
    text("name", 120);
    text("website", 300);
    text("purpose", 300);
    text("dataLocation", 200);
    text("notes", 4000);
    if (body.category !== undefined) {
      if (!CATEGORIES.includes(body.category as VendorCategory))
        throw new AppError(400, "Unknown category", "BAD_REQUEST");
      vendor.category = body.category as VendorCategory;
      changed.push("category");
    }
    if (body.tier !== undefined) {
      const tier = Number(body.tier);
      if (![1, 2, 3].includes(tier))
        throw new AppError(400, "Tier must be 1, 2 or 3", "BAD_REQUEST");
      vendor.tier = tier as VendorTier;
      // The review cadence follows the tier.
      if (vendor.assessmentCompletedAt)
        vendor.nextReviewAt = nextReviewDate(
          vendor.tier,
          vendor.assessmentCompletedAt,
        );
      changed.push("tier");
    }
    if (body.ownerUserId !== undefined) {
      if (body.ownerUserId === null) vendor.ownerUserId = null;
      else {
        const owner = String(body.ownerUserId);
        if (
          !Types.ObjectId.isValid(owner) ||
          !(await WorkspaceMemberModel.exists({
            workspaceId: vendor.workspaceId,
            userId: owner,
          }))
        )
          throw new AppError(
            400,
            "The owner must be a member of the workspace",
            "BAD_REQUEST",
          );
        vendor.ownerUserId = new Types.ObjectId(owner);
      }
      changed.push("owner");
    }
    if (body.dpaExpiresAt !== undefined) {
      vendor.dpaExpiresAt = dateOrNull(body.dpaExpiresAt, "dpaExpiresAt");
      changed.push("DPA expiry");
    }
    if (body.contractRenewalAt !== undefined) {
      vendor.contractRenewalAt = dateOrNull(
        body.contractRenewalAt,
        "contractRenewalAt",
      );
      changed.push("contract renewal");
    }
    if (typeof body.includeInSubprocessors === "boolean") {
      vendor.includeInSubprocessors = body.includeInSubprocessors;
      changed.push("sub-processor listing");
    }
    if (changed.length) {
      vendor.history.push({
        at: new Date(),
        by: new Types.ObjectId(userId),
        action: "updated",
        note: changed.join(", "),
      });
      if (vendor.history.length > 200)
        vendor.history = vendor.history.slice(-200);
    }
    await vendor.save();
    await vendorService.recomputeRisk(vendor);
    res.json({ success: true, data: serialize(vendor) });
  };

  /** POST /vendors/:id/status: approve, restrict, block or return to review. */
  public setStatus = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const vendor = await this.load(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = String(body.status ?? "") as VendorStatus;
    if (!VENDOR_STATUSES.includes(status))
      throw new AppError(
        400,
        `status must be one of ${VENDOR_STATUSES.join(", ")}`,
        "BAD_REQUEST",
      );
    const reason = str(body.reason)?.slice(0, 500) ?? null;
    if ((status === "blocked" || status === "restricted") && !reason)
      throw new AppError(
        400,
        "Give a reason for restricting or blocking a vendor",
        "BAD_REQUEST",
      );
    if (vendor.status === status)
      return res.json({ success: true, data: serialize(vendor) });
    await vendorService.setStatus(vendor, status, userId, reason);
    // Its agents' cached checks must see the change at once.
    const { default: agentService } =
      await import("../agents/agent.service.js");
    agentService.invalidate();
    res.json({ success: true, data: serialize(vendor) });
  };

  /** PUT /vendors/:id/assessment: save answers; `complete` finishes the assessment. */
  public saveAssessment = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const vendor = await this.load(req, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const answers = sanitizeAnswers(body.answers);
    const complete = body.complete === true;
    if (complete) {
      const missing = missingAnswers(answers);
      if (missing.length)
        throw new AppError(
          400,
          `Answer every required question first (${missing.length} left)`,
          "BAD_REQUEST",
        );
    }
    await vendorService.saveAssessment(vendor, answers, complete, userId);
    res.json({ success: true, data: serialize(vendor) });
  };

  /** POST /vendors/:id/evidence: raw file body; ?kind=&name=&expiresAt= */
  public uploadEvidence = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const vendor = await this.load(req, userId);
    if (!Buffer.isBuffer(req.body))
      throw new AppError(
        415,
        `Upload the file itself as the request body (${ALLOWED_EVIDENCE_TYPES.join(", ")})`,
        "UNSUPPORTED_MEDIA_TYPE",
      );
    const kind = String(req.query.kind ?? "other") as EvidenceKind;
    if (!EVIDENCE_KINDS.includes(kind))
      throw new AppError(
        400,
        `kind must be one of ${EVIDENCE_KINDS.join(", ")}`,
        "BAD_REQUEST",
      );
    const expiresAt = req.query.expiresAt
      ? dateOrNull(req.query.expiresAt, "expiresAt")
      : null;
    const evidence = await evidenceService.upload({
      vendor,
      userId,
      body: req.body,
      contentType: String(req.headers["content-type"] ?? ""),
      fileName: str(req.query.name) ?? "evidence",
      kind,
      expiresAt,
    });
    vendor.history.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: "evidence",
      note: `Added ${evidence.name}`,
    });
    await vendor.save();
    await vendorService.recomputeRisk(vendor);
    res.status(201).json({
      success: true,
      data: {
        ...evidence.toObject(),
        id: evidence._id.toString(),
        fileId: undefined,
      },
    });
  };

  private loadEvidence = async (req: AuthenticatedRequest, userId: string) => {
    const vendor = await this.load(req, userId);
    const evidence = await VendorEvidenceModel.findOne({
      _id: param(req, "evidenceId"),
      vendorId: vendor._id,
    });
    if (!evidence) throw new AppError(404, "File not found", "NOT_FOUND");
    return { vendor, evidence };
  };

  /** GET /vendors/:id/evidence/:evidenceId: download as an attachment. */
  public downloadEvidence = async (
    req: AuthenticatedRequest,
    res: Response,
  ) => {
    const userId = userIdOf(req);
    const { evidence } = await this.loadEvidence(req, userId);
    res.setHeader("Content-Type", evidence.contentType);
    res.setHeader("Content-Length", String(evidence.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${evidence.name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(evidence.name)}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, no-store");
    evidenceService
      .stream(evidence)
      .on("error", () => {
        if (!res.headersSent) res.status(404).end();
        else res.destroy();
      })
      .pipe(res);
  };

  public deleteEvidence = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const { vendor, evidence } = await this.loadEvidence(req, userId);
    await evidenceService.remove(evidence);
    vendor.history.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: "evidence",
      note: `Removed ${evidence.name}`,
    });
    await vendor.save();
    await vendorService.recomputeRisk(vendor);
    res.json({ success: true });
  };

  /** DELETE /vendors/:id: only when nothing uses it any more. */
  public remove = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const vendor = await this.load(req, userId);
    const inUse =
      (await AgentModel.exists({
        vendorId: vendor._id,
        status: { $ne: "revoked" },
      })) || (await AgentWebhookModel.exists({ vendorId: vendor._id }));
    if (inUse)
      throw new AppError(
        409,
        `${vendor.name} is still used by agents or webhooks. Block it instead, or remove those first.`,
        "CONFLICT",
      );
    await evidenceService.removeAll(vendor._id as Types.ObjectId);
    await AgentModel.updateMany(
      { vendorId: vendor._id },
      { $set: { vendorId: null } },
    );
    await vendor.deleteOne();
    vendorService.invalidate(vendor._id.toString());
    res.json({ success: true });
  };

  /** GET /vendors/export?format=csv|json: the full register. */
  public exportRegister = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const vendors = await VendorModel.find({ workspaceId })
      .sort({ name: 1 })
      .populate("ownerUserId", "name email");
    const date = new Date().toISOString().slice(0, 10);
    const rows = vendors.map((v) => {
      const owner = v.ownerUserId as unknown as {
        name?: string;
        email?: string;
      } | null;
      return {
        name: v.name,
        category: v.category,
        status: v.status,
        tier: v.tier,
        owner: owner ? owner.name || owner.email : "",
        purpose: v.purpose ?? "",
        dataLocation: v.dataLocation ?? "",
        inherentRisk: v.inherentRisk,
        residualRisk: v.residualRisk,
        riskLevel: v.riskLevel,
        assessedAt: v.assessmentCompletedAt?.toISOString() ?? "",
        nextReviewAt: v.nextReviewAt?.toISOString() ?? "",
        dpaExpiresAt: v.dpaExpiresAt?.toISOString() ?? "",
        contractRenewalAt: v.contractRenewalAt?.toISOString() ?? "",
        subprocessor: v.includeInSubprocessors,
        firstSeenAt: v.firstSeenAt.toISOString(),
        sources: v.sources.join(" "),
      };
    });
    if (req.query.format === "csv") {
      const header = Object.keys(rows[0] ?? { name: "" });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="vendor-register-${date}.csv"`,
      );
      return res.send(
        toCsv(
          header,
          rows.map((r) => header.map((h) => r[h as keyof typeof r])),
        ),
      );
    }
    res.json({
      success: true,
      data: { generatedAt: new Date().toISOString(), vendors: rows },
    });
  };

  /** GET /vendors/subprocessors?format=csv|json: approved vendors you list publicly. */
  public subprocessors = async (req: AuthenticatedRequest, res: Response) => {
    const userId = userIdOf(req);
    const workspaceId = await requireWorkspace(req, userId);
    const vendors = await VendorModel.find({
      workspaceId,
      includeInSubprocessors: true,
      status: "approved",
    }).sort({ name: 1 });
    const rows = vendors.map((v) => ({
      name: v.name,
      purpose: v.purpose ?? "",
      location:
        v.dataLocation ??
        (v.answers as Record<string, string>)?.data_location ??
        "",
      website: v.website ?? "",
    }));
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="sub-processors-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send(
        toCsv(
          ["name", "purpose", "location", "website"],
          rows.map((r) => [r.name, r.purpose, r.location, r.website]),
        ),
      );
    }
    res.json({ success: true, data: rows });
  };
}

export default new VendorController();
