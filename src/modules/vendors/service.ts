import { Types } from "mongoose";

import logger from "../../lib/logger.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import type { RiskLevel } from "../mcp/registry/tool-types.js";
import { raiseAlert } from "../agents/activity.service.js";
import {
  AgentModel,
  AgentWebhookModel,
  type IAgentDocument,
  type IAgentWebhookDocument,
} from "../agents/model.js";
import {
  vendorForAgent,
  vendorForUrl,
  type CatalogVendor,
  type VendorCategory,
} from "./catalog.js";
import {
  VendorEvidenceModel,
  VendorModel,
  type IVendorDocument,
  type VendorSource,
  type VendorStatus,
} from "./model.js";
import { QUESTIONNAIRE_VERSION, type Answers } from "./questionnaire.js";
import {
  expiresWithin,
  nextReviewDate,
  scoreVendor,
  type VendorTier,
} from "./risk.js";

/**
 * Vendor discovery, linking and enforcement. Agents and webhooks are linked
 * to the company behind them as they appear; a vendor's status then limits
 * what every linked agent may do (see decide()).
 */

const CACHE_TTL_MS = 10_000;
const DAY = 86400000;
/** How long a newly found vendor may wait for review before admins are reminded. */
export const REVIEW_GRACE_DAYS = 14;
/** Reminder window for expiring evidence and contracts. */
export const EXPIRY_NOTICE_DAYS = 30;

const DEFAULT_TIER: Record<VendorCategory, VendorTier> = {
  ai_model: 1,
  ai_assistant: 2,
  automation: 2,
  developer_tool: 2,
  observability: 3,
  communication: 3,
  other: 2,
};

const SOURCE_OF: Record<string, VendorSource> = {
  ai_provider: "ai_provider",
  mcp_client: "mcp_client",
  chatgpt: "chatgpt",
  detected: "detected",
};

export interface VendorDecision {
  deny: string;
}

class VendorService {
  private statusCache = new Map<
    string,
    { value: { status: VendorStatus; name: string } | null; at: number }
  >();
  private strictCache = new Map<string, { value: boolean; at: number }>();

  public invalidate(vendorId?: string): void {
    if (vendorId) this.statusCache.delete(vendorId);
    else this.statusCache.clear();
    this.strictCache.clear();
  }

  /** Finds or creates the workspace's record for a catalog vendor. */
  public async ensureVendor(
    workspaceId: string,
    entry: CatalogVendor,
    source: VendorSource,
  ): Promise<{ vendor: IVendorDocument; created: boolean }> {
    const now = new Date();
    const result = await VendorModel.updateOne(
      { workspaceId, key: entry.key },
      {
        $setOnInsert: {
          workspaceId,
          key: entry.key,
          name: entry.name,
          category: entry.category,
          website: entry.website || null,
          purpose: entry.purpose || null,
          tier: DEFAULT_TIER[entry.category],
          status: "under_review",
          firstSeenAt: now,
          answers: {},
          history: [
            {
              at: now,
              action: "discovered",
              note: `Found through ${source.replace("_", " ")}`,
            },
          ],
        },
        $addToSet: { sources: source },
        $set: { lastSeenAt: now },
      },
      { upsert: true },
    );
    const vendor = await VendorModel.findOne({ workspaceId, key: entry.key });
    if (!vendor) throw new Error("Vendor upsert failed");
    return { vendor, created: result.upsertedCount > 0 };
  }

  /** Links an agent to its vendor; new vendors raise an alert to review them. */
  public async linkAgent(agent: IAgentDocument): Promise<void> {
    if (agent.vendorId || !agent.workspaceId) return;
    const entry = vendorForAgent(agent);
    if (!entry) return;
    try {
      const { vendor, created } = await this.ensureVendor(
        agent.workspaceId.toString(),
        entry,
        SOURCE_OF[agent.kind] ?? "manual",
      );
      await AgentModel.updateOne(
        { _id: agent._id },
        { $set: { vendorId: vendor._id } },
      );
      agent.vendorId = vendor._id as Types.ObjectId;
      if (created) {
        await raiseAlert({
          workspaceId: agent.workspaceId.toString(),
          agentId: agent._id.toString(),
          vendorId: vendor._id.toString(),
          type: "new_vendor",
          severity: "info",
          title: `New third party: ${vendor.name}`,
          detail: `${agent.name} uses ${vendor.name}. Review it under Agent Governance → Vendors.`,
          dedupeKey: `new_vendor:${vendor._id}`,
        });
      }
      await this.recomputeRisk(vendor);
    } catch (error) {
      logger.warn("Could not link agent to its vendor", {
        agentId: agent._id.toString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async linkWebhook(hook: IAgentWebhookDocument): Promise<void> {
    const entry = vendorForUrl(hook.url);
    if (!entry) {
      if (hook.vendorId)
        await AgentWebhookModel.updateOne(
          { _id: hook._id },
          { $set: { vendorId: null } },
        );
      return;
    }
    const { vendor } = await this.ensureVendor(
      hook.workspaceId.toString(),
      entry,
      "webhook",
    );
    await AgentWebhookModel.updateOne(
      { _id: hook._id },
      { $set: { vendorId: vendor._id } },
    );
    hook.vendorId = vendor._id as Types.ObjectId;
  }

  /** Links agents and webhooks that predate vendor discovery. */
  public async syncWorkspace(workspaceId: string): Promise<void> {
    const agents = await AgentModel.find({
      workspaceId,
      vendorId: null,
      status: { $ne: "revoked" },
      kind: { $in: ["ai_provider", "mcp_client", "chatgpt", "detected"] },
    }).limit(500);
    for (const agent of agents) await this.linkAgent(agent);
    const hooks = await AgentWebhookModel.find({
      workspaceId,
      vendorId: null,
    }).limit(50);
    for (const hook of hooks) await this.linkWebhook(hook);
  }

  public async statusOf(
    vendorId: string,
  ): Promise<{ status: VendorStatus; name: string } | null> {
    const hit = this.statusCache.get(vendorId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const vendor = await VendorModel.findById(vendorId)
      .select("status name")
      .lean();
    const value = vendor ? { status: vendor.status, name: vendor.name } : null;
    if (this.statusCache.size > 10_000) this.statusCache.clear();
    this.statusCache.set(vendorId, { value, at: Date.now() });
    return value;
  }

  private async approvedOnly(workspaceId: string): Promise<boolean> {
    const hit = this.strictCache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const workspace = await WorkspaceModel.findById(workspaceId)
      .select("settings.approvedVendorsOnly")
      .lean();
    const value = Boolean(workspace?.settings?.approvedVendorsOnly);
    if (this.strictCache.size > 10_000) this.strictCache.clear();
    this.strictCache.set(workspaceId, { value, at: Date.now() });
    return value;
  }

  /**
   * What a vendor's status allows its agents: blocked vendors nothing;
   * restricted vendors (and vendors under review when the workspace only
   * allows approved ones) reads only, and AI providers send nothing.
   */
  public async decide(
    agent: Pick<IAgentDocument, "vendorId" | "workspaceId" | "kind">,
    risk: RiskLevel,
  ): Promise<VendorDecision | null> {
    if (!agent.vendorId) return null;
    const vendor = await this.statusOf(agent.vendorId.toString());
    if (!vendor || vendor.status === "approved") return null;
    if (vendor.status === "blocked")
      return {
        deny: `${vendor.name} is blocked as a third party in this workspace.`,
      };
    const limited =
      vendor.status === "restricted" ||
      (vendor.status === "under_review" &&
        agent.workspaceId != null &&
        (await this.approvedOnly(agent.workspaceId.toString())));
    if (limited && (agent.kind === "ai_provider" || risk !== "read")) {
      return {
        deny:
          vendor.status === "restricted"
            ? `${vendor.name} is restricted in this workspace: read-only.`
            : `${vendor.name} is awaiting third-party review; until it is approved it can only read.`,
      };
    }
    return null;
  }

  public async setStatus(
    vendor: IVendorDocument,
    status: VendorStatus,
    userId: string,
    reason: string | null,
  ): Promise<IVendorDocument> {
    const from = vendor.status;
    vendor.status = status;
    vendor.statusReason = reason;
    vendor.history.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: "status",
      from,
      to: status,
      note: reason,
    });
    if (vendor.history.length > 200)
      vendor.history = vendor.history.slice(-200);
    await vendor.save();
    this.invalidate(vendor._id.toString());
    return vendor;
  }

  public async saveAssessment(
    vendor: IVendorDocument,
    answers: Answers,
    complete: boolean,
    userId: string,
  ): Promise<IVendorDocument> {
    vendor.answers = answers;
    vendor.markModified("answers");
    vendor.questionnaireVersion = QUESTIONNAIRE_VERSION;
    if (complete) {
      const now = new Date();
      vendor.assessmentCompletedAt = now;
      vendor.assessmentCompletedBy = new Types.ObjectId(userId);
      vendor.nextReviewAt = nextReviewDate(vendor.tier, now);
      vendor.history.push({
        at: now,
        by: new Types.ObjectId(userId),
        action: "assessed",
      });
    }
    await vendor.save();
    return this.recomputeRisk(vendor);
  }

  public async recomputeRisk(
    vendor: IVendorDocument,
  ): Promise<IVendorDocument> {
    const now = new Date();
    const [agents, evidence, workspace] = await Promise.all([
      AgentModel.find({ vendorId: vendor._id, status: { $ne: "revoked" } })
        .select("kind scopes projectIds")
        .lean(),
      VendorEvidenceModel.find({
        vendorId: vendor._id,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
        .select("kind")
        .lean(),
      WorkspaceModel.findById(vendor.workspaceId)
        .select("settings.aiDataMasking")
        .lean(),
    ]);
    const result = scoreVendor({
      category: vendor.category,
      tier: vendor.tier,
      scopes: [...new Set(agents.flatMap((a) => a.scopes ?? []))],
      receivesContent: agents.some((a) => a.kind === "ai_provider"),
      allProjects: agents.some(
        (a) => a.kind !== "ai_provider" && (a.projectIds ?? []).length === 0,
      ),
      answers: (vendor.answers ?? {}) as Answers,
      assessmentCompletedAt: vendor.assessmentCompletedAt,
      nextReviewAt: vendor.nextReviewAt,
      evidence: evidence.map((e) => e.kind),
      dpaExpiresAt: vendor.dpaExpiresAt,
      workspaceMasksAiData: Boolean(workspace?.settings?.aiDataMasking),
      now,
    });
    await VendorModel.updateOne(
      { _id: vendor._id },
      {
        $set: {
          inherentRisk: result.inherent,
          residualRisk: result.residual,
          riskLevel: result.level,
          riskFactors: result.factors,
          riskEvaluatedAt: now,
        },
      },
    );
    vendor.inherentRisk = result.inherent;
    vendor.residualRisk = result.residual;
    vendor.riskLevel = result.level;
    vendor.riskFactors = result.factors;
    vendor.riskEvaluatedAt = now;
    return vendor;
  }

  /**
   * Nightly: links stragglers, rescores every vendor and reminds admins of
   * reviews due, vendors waiting for review, and expiring evidence or
   * contracts. Alerts are de-duplicated per vendor and month.
   */
  public async nightly(
    now = new Date(),
  ): Promise<{ vendors: number; reminders: number }> {
    let vendors = 0;
    let reminders = 0;
    const month = now.toISOString().slice(0, 7);
    const remind = async (
      vendor: IVendorDocument,
      type: string,
      severity: "info" | "warning" | "critical",
      title: string,
      detail: string,
      /** Distinguishes several reminders of one type, e.g. per evidence file. */
      key = "",
    ) => {
      const raised = await raiseAlert({
        workspaceId: vendor.workspaceId.toString(),
        vendorId: vendor._id.toString(),
        type,
        severity,
        title,
        detail,
        dedupeKey: `${type}:${vendor._id}:${key}:${month}`,
      });
      if (raised) reminders += 1;
    };

    const workspaces = await VendorModel.distinct("workspaceId");
    for (const workspaceId of workspaces) {
      await this.syncWorkspace(String(workspaceId)).catch(() => undefined);
    }

    const cursor = VendorModel.find({ status: { $ne: "blocked" } }).cursor();
    for await (const vendor of cursor) {
      vendors += 1;
      try {
        await this.recomputeRisk(vendor);
        if (
          vendor.nextReviewAt &&
          vendor.nextReviewAt.getTime() < now.getTime()
        ) {
          await remind(
            vendor,
            "vendor_review_due",
            "warning",
            `${vendor.name}: reassessment due`,
            `Its last assessment is older than the tier ${vendor.tier} cadence. Update the questionnaire under Vendors.`,
          );
        }
        if (
          vendor.status === "under_review" &&
          now.getTime() - vendor.firstSeenAt.getTime() > REVIEW_GRACE_DAYS * DAY
        ) {
          await remind(
            vendor,
            "vendor_unreviewed",
            "warning",
            `${vendor.name} is still awaiting review`,
            `Found ${Math.floor((now.getTime() - vendor.firstSeenAt.getTime()) / DAY)} days ago and not yet approved, restricted or blocked.`,
          );
        }
        if (
          vendor.dpaExpiresAt &&
          vendor.dpaExpiresAt.getTime() <= now.getTime()
        ) {
          await remind(
            vendor,
            "vendor_dpa_expired",
            "critical",
            `${vendor.name}: data processing agreement expired`,
            "Renew it, or restrict the vendor until a new one is signed.",
          );
        } else if (
          expiresWithin(vendor.dpaExpiresAt, EXPIRY_NOTICE_DAYS, now)
        ) {
          await remind(
            vendor,
            "vendor_dpa_expiring",
            "warning",
            `${vendor.name}: data processing agreement expires soon`,
            `It expires on ${vendor.dpaExpiresAt!.toISOString().slice(0, 10)}.`,
          );
        }
        if (expiresWithin(vendor.contractRenewalAt, EXPIRY_NOTICE_DAYS, now)) {
          await remind(
            vendor,
            "vendor_contract_renewal",
            "info",
            `${vendor.name}: contract renews soon`,
            `Renewal on ${vendor.contractRenewalAt!.toISOString().slice(0, 10)}: a good moment to reassess it.`,
          );
        }
        const evidence = await VendorEvidenceModel.find({
          vendorId: vendor._id,
          expiresAt: {
            $ne: null,
            $lte: new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY),
          },
        }).lean();
        for (const item of evidence) {
          const expired = item.expiresAt!.getTime() <= now.getTime();
          await remind(
            vendor,
            expired ? "vendor_evidence_expired" : "vendor_evidence_expiring",
            expired ? "warning" : "info",
            `${vendor.name}: ${item.name} ${expired ? "has expired" : "expires soon"}`,
            `Ask ${vendor.name} for a current copy and upload it under Evidence.`,
            item._id.toString(),
          );
        }
      } catch (error) {
        logger.warn("Vendor nightly check failed", {
          vendorId: vendor._id.toString(),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { vendors, reminders };
  }
}

export default new VendorService();
