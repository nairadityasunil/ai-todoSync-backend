import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
import PromptCanaryDeploymentModel from "../models/prompt-canary-deployment.model.js";
import promptAuthorizationService from "./prompt-authorization.service.js";
import workspaceService from "../../workspace/services/workspace.service.js";
import { HttpError } from "../../../shared/errors/http-error.js";
import { runInTransaction } from "../../../utils/transaction.js";
import logger from "../../../lib/logger.js";
import {
  checkPrompt,
  hasBlockingFindings,
} from "../../agents/prompt-checks.js";

export class PromptVersionService {
  public async getPromptVersions(
    workspaceId: string,
    userId: string,
    promptId: string,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const prompt = await PromptLibraryModel.findOne({
      _id: promptId,
      workspaceId,
    });
    if (!prompt) {
      throw new HttpError(404, "Prompt not found.");
    }
    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );

    const rootId = prompt.parentId || prompt._id;

    return PromptVersionModel.find({ promptId: rootId })
      .sort({ version: -1 })
      .populate("changedBy", "name email avatar")
      .lean();
  }

  public async comparePromptVersions(
    workspaceId: string,
    userId: string,
    promptId: string,
    v1: number,
    v2: number,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const prompt = await PromptLibraryModel.findOne({
      _id: promptId,
      workspaceId,
    });
    if (!prompt) {
      throw new HttpError(404, "Prompt not found.");
    }
    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );

    const rootId = prompt.parentId || prompt._id;

    const [ver1, ver2] = await Promise.all([
      PromptVersionModel.findOne({ promptId: rootId, version: v1 }).lean(),
      PromptVersionModel.findOne({ promptId: rootId, version: v2 }).lean(),
    ]);

    if (!ver1 || !ver2) {
      throw new HttpError(
        404,
        "One or both specified versions were not found.",
      );
    }

    return {
      v1: ver1,
      v2: ver2,
      hashMatch: ver1.hash === ver2.hash,
    };
  }

  public async moveToStaging(
    workspaceId: string,
    userId: string,
    promptId: string,
    versionNumber: number,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const prompt = await PromptLibraryModel.findOne({
      _id: promptId,
      workspaceId,
    });
    if (!prompt) {
      throw new HttpError(404, "Prompt not found.");
    }
    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );

    const rootId = prompt.parentId || prompt._id;

    const targetVersion = await PromptVersionModel.findOne({
      promptId: rootId,
      version: versionNumber,
    });

    if (!targetVersion) {
      throw new HttpError(404, `Version ${versionNumber} not found.`);
    }

    if (targetVersion.environment === "production") {
      throw new HttpError(
        400,
        "Cannot move active production version directly to staging without deploying another production version.",
      );
    }

    const inCanary = await PromptCanaryDeploymentModel.exists({
      promptId: rootId,
      candidateVersion: versionNumber,
      status: { $in: ["active", "paused"] },
    });
    if (inCanary) {
      throw new HttpError(
        409,
        `Version ${versionNumber} is in a canary rollout. Complete, roll back or cancel it first.`,
      );
    }

    targetVersion.environment = "staging";
    await targetVersion.save();

    logger.info(
      `Prompt ${rootId} version ${versionNumber} moved to environment: staging`,
    );
    return targetVersion;
  }

  public async moveToDevelopment(
    workspaceId: string,
    userId: string,
    promptId: string,
    versionNumber: number,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const prompt = await PromptLibraryModel.findOne({
      _id: promptId,
      workspaceId,
    });
    if (!prompt) {
      throw new HttpError(404, "Prompt not found.");
    }
    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );

    const rootId = prompt.parentId || prompt._id;

    const targetVersion = await PromptVersionModel.findOne({
      promptId: rootId,
      version: versionNumber,
    });

    if (!targetVersion) {
      throw new HttpError(404, `Version ${versionNumber} not found.`);
    }

    if (targetVersion.environment === "production") {
      throw new HttpError(
        400,
        "Cannot move active production version directly to development without deploying another production version.",
      );
    }

    targetVersion.environment = "development";
    await targetVersion.save();

    logger.info(
      `Prompt ${rootId} version ${versionNumber} moved to environment: development`,
    );
    return targetVersion;
  }

  public async deployDirectToProduction(
    workspaceId: string,
    userId: string,
    promptId: string,
    versionNumber: number,
    options: { acknowledgeChecks?: boolean } = {},
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const prompt = await PromptLibraryModel.findOne({
      _id: promptId,
      workspaceId,
    });
    if (!prompt) {
      throw new HttpError(404, "Prompt not found.");
    }
    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );

    const rootId = prompt.parentId || prompt._id;

    const targetVersion = await PromptVersionModel.findOne({
      promptId: rootId,
      version: versionNumber,
    });

    if (!targetVersion) {
      throw new HttpError(404, `Version ${versionNumber} not found.`);
    }

    // Same pre-deployment checks as a canary: all traffic is about to see it.
    const findings = checkPrompt({
      body: targetVersion.body,
      messages: targetVersion.messages,
    });
    if (hasBlockingFindings(findings) && !options.acknowledgeChecks) {
      throw new HttpError(
        422,
        `Prompt checks failed: ${findings
          .filter((finding) => finding.severity === "high")
          .map((finding) => finding.message)
          .join(" ")} Fix the prompt or publish again with acknowledgeChecks.`,
      );
    }

    // Cancel any active canary deployment so direct deploy takes over
    await PromptCanaryDeploymentModel.updateMany(
      { promptId: rootId, status: { $in: ["active", "paused"] } },
      {
        $set: {
          status: "cancelled",
          rollbackReason: `Cancelled due to direct deployment of version ${versionNumber}`,
        },
      },
    );

    return runInTransaction(async (session) => {
      // 1. Demote current production version to staging
      await PromptVersionModel.updateMany(
        { promptId: rootId, environment: "production" },
        { $set: { environment: "staging" } },
        { session },
      );

      // 2. Promote target version to production
      targetVersion.environment = "production";
      await targetVersion.save({ session });

      // 3. Update PromptLibrary metadata
      await PromptLibraryModel.updateMany(
        { $or: [{ _id: rootId }, { parentId: rootId }] },
        {
          $set: {
            productionVersion: versionNumber,
            isProductionPublished: true,
            publishedAt: new Date(),
          },
        },
        { session },
      );

      logger.info(
        `Prompt ${rootId} version ${versionNumber} directly deployed to production.`,
      );

      return {
        promptId: rootId,
        productionVersion: versionNumber,
        publishedAt: new Date(),
        environment: "production",
      };
    });
  }

  public async publishProductionVersion(
    workspaceId: string,
    userId: string,
    promptId: string,
    versionNumber: number,
    options: { acknowledgeChecks?: boolean } = {},
  ) {
    return this.deployDirectToProduction(
      workspaceId,
      userId,
      promptId,
      versionNumber,
      options,
    );
  }
}

export default new PromptVersionService();
