import PromptCanaryDeploymentModel, {
  type IPromptCanaryDeploymentDocument,
} from "../models/prompt-canary-deployment.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
import promptAuthorizationService from "./prompt-authorization.service.js";
import workspaceService from "../../workspace/services/workspace.service.js";
import { HttpError } from "../../../shared/errors/http-error.js";
import { runInTransaction } from "../../../utils/transaction.js";
import logger from "../../../lib/logger.js";
import {
  checkPrompt,
  hasBlockingFindings,
} from "../../agents/prompt-checks.js";

export interface StartCanaryPayload {
  candidateVersion: number;
  minRequests?: number;
  errorThreshold?: number; // e.g. 0.05
  /** Start even though the pre-deployment prompt checks found high-severity issues. */
  acknowledgeChecks?: boolean;
}

export class PromptCanaryService {
  private async assertPromptAccess(
    workspaceId: string,
    userId: string,
    promptId: string,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const prompt = await PromptLibraryModel.findById(promptId);
    if (!prompt) {
      throw new HttpError(404, "Prompt not found");
    }
    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );
    return prompt;
  }

  /**
   * Starts a canary deployment for a prompt.
   */
  public async startCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
    payload: StartCanaryPayload,
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const candidateVersionDoc = await PromptVersionModel.findOne({
      promptId: rootId,
      version: payload.candidateVersion,
    });
    if (!candidateVersionDoc) {
      throw new HttpError(
        404,
        `Candidate version ${payload.candidateVersion} not found`,
      );
    }

    // Pre-deployment checks: secrets and injection phrases block the rollout.
    const findings = checkPrompt({
      body: candidateVersionDoc.body,
      messages: candidateVersionDoc.messages,
    });
    if (hasBlockingFindings(findings) && !payload.acknowledgeChecks) {
      throw new HttpError(
        422,
        `Prompt checks failed: ${findings
          .filter((finding) => finding.severity === "high")
          .map((finding) => finding.message)
          .join(" ")} Fix the prompt or start again with acknowledgeChecks.`,
      );
    }

    const legacyVersion = prompt.productionVersion || 1;
    if (candidateVersionDoc.version === legacyVersion) {
      throw new HttpError(
        400,
        `Candidate version ${payload.candidateVersion} is already the current production version`,
      );
    }

    // Check existing active or paused canary deployment
    const existingActive = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: { $in: ["active", "paused"] },
    });
    if (existingActive) {
      throw new HttpError(
        400,
        "A canary deployment is already active or paused for this prompt. Roll back or complete it first.",
      );
    }

    const minRequests = payload.minRequests ?? 10;
    const errorThreshold = payload.errorThreshold ?? 0.05;

    const canary = await PromptCanaryDeploymentModel.create({
      workspaceId,
      promptId: rootId,
      legacyVersion,
      candidateVersion: candidateVersionDoc.version,
      status: "active",
      currentPhase: 1,
      trafficWeight: { canary: 5, legacy: 95 },
      rolloutProgress: 5,
      minRequests,
      errorThreshold,
      createdBy: userId,
      startedAt: new Date(),
    });

    await PromptVersionModel.updateOne(
      { promptId: rootId, version: candidateVersionDoc.version },
      { $set: { environment: "canary" } },
    );

    logger.info(
      `Canary deployment started for prompt ${rootId} (candidate v${payload.candidateVersion})`,
    );
    return canary;
  }

  /**
   * Advances canary rollout phase: Phase 1 (5%) -> Phase 2 (25%) -> Phase 3 (50%) -> Phase 4 (100%) -> Complete.
   */
  public async advanceCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const canary = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: { $in: ["active", "paused"] },
    });

    if (!canary) {
      throw new HttpError(
        404,
        "No active or paused canary deployment found for this prompt",
      );
    }

    if (canary.currentPhase >= 4) {
      // Complete deployment
      return this.completeCanary(workspaceId, userId, promptId);
    }

    const nextPhase = canary.currentPhase + 1;
    let canaryWeight = 5;
    if (nextPhase === 2) canaryWeight = 25;
    if (nextPhase === 3) canaryWeight = 50;
    if (nextPhase === 4) canaryWeight = 100;

    canary.currentPhase = nextPhase;
    canary.trafficWeight = { canary: canaryWeight, legacy: 100 - canaryWeight };
    canary.rolloutProgress = canaryWeight;
    canary.status = "active";
    await canary.save();

    logger.info(
      `Canary deployment advanced to Phase ${nextPhase} (${canaryWeight}% traffic) for prompt ${rootId}`,
    );
    return canary;
  }

  /**
   * Pauses an active canary deployment (routes 100% traffic to legacy production version).
   */
  public async pauseCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const canary = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: "active",
    });

    if (!canary) {
      throw new HttpError(404, "No active canary deployment found to pause");
    }

    canary.status = "paused";
    canary.pausedAt = new Date();
    await canary.save();

    logger.info(`Canary deployment paused for prompt ${rootId}`);
    return canary;
  }

  /**
   * Resumes a paused canary deployment.
   */
  public async resumeCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const canary = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: "paused",
    });

    if (!canary) {
      throw new HttpError(404, "No paused canary deployment found to resume");
    }

    canary.status = "active";
    await canary.save();

    logger.info(`Canary deployment resumed for prompt ${rootId}`);
    return canary;
  }

  /**
   * Rolls back a canary deployment.
   */
  public async rollbackCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
    reason: string = "Manual rollback",
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const canary = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: { $in: ["active", "paused"] },
    });

    if (!canary) {
      throw new HttpError(
        404,
        "No active or paused canary deployment found to roll back",
      );
    }

    canary.status = "rolled_back";
    canary.rolledBackAt = new Date();
    canary.rollbackReason = reason;
    await canary.save();

    await PromptVersionModel.updateOne(
      { promptId: rootId, version: canary.candidateVersion },
      { $set: { environment: "staging" } },
    );

    logger.info(
      `Canary deployment rolled back for prompt ${rootId}. Reason: ${reason}`,
    );
    return canary;
  }

  /**
   * Cancels a canary deployment without marking it as failed.
   */
  public async cancelCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
    reason: string = "Cancelled by user",
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const canary = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: { $in: ["active", "paused"] },
    });

    if (!canary) {
      throw new HttpError(
        404,
        "No active or paused canary deployment found to cancel",
      );
    }

    canary.status = "cancelled";
    canary.rollbackReason = reason;
    await canary.save();

    await PromptVersionModel.updateOne(
      { promptId: rootId, version: canary.candidateVersion },
      { $set: { environment: "staging" } },
    );

    logger.info(`Canary deployment cancelled for prompt ${rootId}`);
    return canary;
  }

  /**
   * Completes a canary deployment, promoting candidate version to production and demoting old production to staging.
   */
  public async completeCanary(
    workspaceId: string,
    userId: string,
    promptId: string,
  ): Promise<IPromptCanaryDeploymentDocument> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    const canary = await PromptCanaryDeploymentModel.findOne({
      promptId: rootId,
      status: { $in: ["active", "paused"] },
    });

    if (!canary) {
      throw new HttpError(
        404,
        "No active or paused canary deployment found to complete",
      );
    }

    return runInTransaction(async (session) => {
      // 1. Demote old production versions to staging
      await PromptVersionModel.updateMany(
        { promptId: rootId, environment: "production" },
        { $set: { environment: "staging" } },
        { session },
      );

      // 2. Promote candidate version to production
      await PromptVersionModel.updateOne(
        { promptId: rootId, version: canary.candidateVersion },
        { $set: { environment: "production" } },
        { session },
      );

      // 3. Update PromptLibrary header
      await PromptLibraryModel.updateMany(
        { $or: [{ _id: rootId }, { parentId: rootId }] },
        {
          $set: {
            productionVersion: canary.candidateVersion,
            isProductionPublished: true,
            publishedAt: new Date(),
          },
        },
        { session },
      );

      // 4. Complete canary deployment
      canary.status = "completed";
      canary.completedAt = new Date();
      canary.rolloutProgress = 100;
      canary.currentPhase = 4;
      canary.trafficWeight = { canary: 100, legacy: 0 };
      await canary.save({ session });

      logger.info(
        `Canary deployment completed for prompt ${rootId}. Version ${canary.candidateVersion} is now production.`,
      );
      return canary;
    });
  }

  /**
   * Retrieves active or latest canary deployment state for a prompt.
   */
  public async getCanaryDeployment(
    workspaceId: string,
    userId: string,
    promptId: string,
  ): Promise<IPromptCanaryDeploymentDocument | null> {
    const prompt = await this.assertPromptAccess(workspaceId, userId, promptId);
    const rootId = prompt.parentId || prompt._id;

    return PromptCanaryDeploymentModel.findOne({ promptId: rootId }).sort({
      createdAt: -1,
    });
  }

  /**
   * Asynchronously records execution metrics for an active canary deployment.
   */
  public async recordExecutionMetrics(
    canaryDeploymentId: string,
    isCanary: boolean,
    isError: boolean,
    latencyMs: number,
    tokens: number,
    cost: number,
  ): Promise<void> {
    try {
      const incFields: Record<string, number> = {
        "metrics.totalRequests": 1,
      };

      if (isCanary) {
        incFields["metrics.canaryRequests"] = 1;
        if (isError) incFields["metrics.canaryErrors"] = 1;
        incFields["metrics.canaryLatencyMsTotal"] = latencyMs;
        incFields["metrics.canaryTokensTotal"] = tokens;
        incFields["metrics.canaryCostTotal"] = cost;
      } else {
        incFields["metrics.legacyRequests"] = 1;
        if (isError) incFields["metrics.legacyErrors"] = 1;
        incFields["metrics.legacyLatencyMsTotal"] = latencyMs;
        incFields["metrics.legacyTokensTotal"] = tokens;
        incFields["metrics.legacyCostTotal"] = cost;
      }

      await PromptCanaryDeploymentModel.findByIdAndUpdate(canaryDeploymentId, {
        $inc: incFields,
      });

      // Evaluate health asynchronously
      await this.evaluateCanaryHealth(canaryDeploymentId);
    } catch (err) {
      logger.error("Failed to record canary execution metrics", { err });
    }
  }

  /**
   * Evaluates health of an active canary deployment against minimum request and error threshold limits.
   */
  private async evaluateCanaryHealth(
    canaryDeploymentId: string,
  ): Promise<void> {
    const canary =
      await PromptCanaryDeploymentModel.findById(canaryDeploymentId);
    if (!canary || canary.status !== "active") return;

    const { canaryRequests, canaryErrors } = canary.metrics;
    if (canaryRequests >= canary.minRequests) {
      const errorRate = canaryErrors / canaryRequests;
      if (errorRate > canary.errorThreshold) {
        canary.status = "failed";
        canary.rolledBackAt = new Date();
        canary.rollbackReason = `Automated rollback: canary error rate (${(
          errorRate * 100
        ).toFixed(1)}%) exceeded threshold (${(
          canary.errorThreshold * 100
        ).toFixed(1)}%) after ${canaryRequests} requests`;
        await canary.save();

        await PromptVersionModel.updateOne(
          { promptId: canary.promptId, version: canary.candidateVersion },
          { $set: { environment: "staging" } },
        );

        logger.warn(
          `Canary deployment FAILED automatically for prompt ${canary.promptId}: ${canary.rollbackReason}`,
        );
      }
    }
  }
}

export default new PromptCanaryService();
