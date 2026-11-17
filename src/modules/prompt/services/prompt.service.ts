import type { Types } from "mongoose";
import PromptFolderModel from "../models/prompt-folder.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
import PromptDeploymentEventModel from "../models/prompt-deployment-event.model.js";
import PromptExecutionLogModel from "../models/prompt-execution-log.model.js";
import ProjectModel from "../../project/models/project.model.js";
import workspaceService from "../../workspace/services/workspace.service.js";
import { runInTransaction } from "../../../utils/transaction.js";
import promptAuthorizationService from "./prompt-authorization.service.js";
import promptVariableService from "./prompt-variable.service.js";
import promptHashService from "./prompt-hash.service.js"; // note .js extension for node module
import promptFolderService from "./prompt-folder.service.js";
import promptFavoriteService from "./prompt-favorite.service.js";
import promptVersionService from "./prompt-version.service.js";
import promptQueryService from "./prompt-query.service.js";
import promptPlaygroundService from "./prompt-playground.service.js";
import promptCanaryService from "./prompt-canary.service.js";
import type {
  CreatePromptPayload,
  UpdatePromptPayload,
} from "../../../interfaces/prompt/prompt.interface.js";

import { HttpError } from "../../../shared/errors/http-error.js";

export { HttpError };

export class PromptService {
  // Delegate helper methods for backward-compatibility
  public validateVariableSchema = promptVariableService.validateVariableSchema;
  public assertPromptAccess = promptAuthorizationService.assertPromptAccess;
  public extractHandlebarsVariables =
    promptVariableService.extractHandlebarsVariables;
  public syncVariables = promptVariableService.syncVariables;
  public validateVariableValues = promptVariableService.validateVariableValues;
  public substituteVariables = promptVariableService.substituteVariables;
  public generateCanonicalHash = promptHashService.generateCanonicalHash;
  public generateSlug = promptHashService.generateSlug;

  // Folder Operations
  public createFolder = promptFolderService.createFolder;
  public listFolders = promptFolderService.listFolders;
  public updateFolder = promptFolderService.updateFolder;
  public deleteFolder = promptFolderService.deleteFolder;

  // Query Operations
  public listPrompts = promptQueryService.listPrompts;
  public getPromptDetails = promptQueryService.getPromptDetails;

  // Favorite & Version Operations
  public toggleFavorite = promptFavoriteService.toggleFavorite;
  public getPromptVersions = promptVersionService.getPromptVersions;
  public comparePromptVersions = promptVersionService.comparePromptVersions;
  public publishProductionVersion =
    promptVersionService.publishProductionVersion;
  public moveToStaging = promptVersionService.moveToStaging;
  public moveToDevelopment = promptVersionService.moveToDevelopment;
  public deployDirectToProduction =
    promptVersionService.deployDirectToProduction;
  public rollbackProduction =
    promptVersionService.rollbackProduction.bind(promptVersionService);
  public getDeploymentHistory =
    promptVersionService.getDeploymentHistory.bind(promptVersionService);
  public startCanary =
    promptCanaryService.startCanary.bind(promptCanaryService);
  public advanceCanary =
    promptCanaryService.advanceCanary.bind(promptCanaryService);
  public pauseCanary =
    promptCanaryService.pauseCanary.bind(promptCanaryService);
  public resumeCanary =
    promptCanaryService.resumeCanary.bind(promptCanaryService);
  public rollbackCanary =
    promptCanaryService.rollbackCanary.bind(promptCanaryService);
  public cancelCanary =
    promptCanaryService.cancelCanary.bind(promptCanaryService);
  public completeCanary =
    promptCanaryService.completeCanary.bind(promptCanaryService);
  public getCanaryDeployment =
    promptCanaryService.getCanaryDeployment.bind(promptCanaryService);
  public runPlayground = promptPlaygroundService.runPlayground;

  // Core Prompt CRUD Operations
  public async createPrompt(
    workspaceId: string,
    userId: string,
    payload: CreatePromptPayload,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    if (!payload.name || !payload.name.trim()) {
      throw new HttpError(400, "Prompt name is required.");
    }

    if (payload.folderId) {
      const folder = await PromptFolderModel.findOne({
        _id: payload.folderId,
        workspaceId,
      });
      if (!folder) {
        throw new HttpError(400, "Folder does not exist in this workspace.");
      }
    }

    if (payload.projectId) {
      const project = await ProjectModel.findOne({
        _id: payload.projectId,
        workspaceId,
      });
      if (!project) {
        throw new HttpError(400, "Project does not exist in this workspace.");
      }
    }

    const bodyText = payload.body || "";
    const messages = payload.messages || [];
    const syncedVariables = promptVariableService.syncVariables(
      bodyText,
      messages,
      payload.variables,
    );
    const newProvider = payload.provider || "gemini";
    const newModelName = payload.modelName || "gemini-3.6-flash";
    const newParameters = payload.parameters || {
      temperature: 0.7,
      maxTokens: 2048,
      topP: 0.95,
      responseFormat: "text",
    };

    const hash = promptHashService.generateCanonicalHash(
      bodyText,
      messages,
      syncedVariables,
      newProvider,
      newModelName,
      newParameters,
    );
    const slug = promptHashService.generateSlug(payload.name);

    const existingSlug = await PromptLibraryModel.findOne({
      workspaceId,
      slug,
      isLatest: true,
    });
    if (existingSlug) {
      throw new HttpError(
        400,
        `A prompt with slug '${slug}' already exists in this workspace.`,
      );
    }

    try {
      return await runInTransaction(async (session) => {
        const promptDocs = await PromptLibraryModel.create(
          [
            {
              workspaceId,
              projectId: payload.projectId || null,
              name: payload.name.trim(),
              slug,
              description: payload.description || "",
              category: payload.category || "general",
              tags: (payload.tags || []).map((t) => t.toLowerCase().trim()),
              body: bodyText,
              messages,
              variables: syncedVariables,
              provider: newProvider,
              modelName: newModelName,
              parameters: newParameters,
              folderId: payload.folderId || null,
              visibility: payload.visibility || "organization",
              createdBy: userId,
              version: 1,
              hash,
              isLatest: true,
              isTemplate: payload.isTemplate || false,
            },
          ],
          { session },
        );

        const newPrompt = promptDocs[0];

        // Create initial version 1 document with environment: development
        await PromptVersionModel.create(
          [
            {
              promptId: newPrompt._id,
              version: 1,
              environment: "development",
              hash,
              body: bodyText,
              messages,
              variables: syncedVariables,
              provider: newProvider,
              modelName: newModelName,
              parameters: newParameters,
              changedBy: userId,
              changeNote: "Initial prompt version 1",
            },
          ],
          { session },
        );

        return newPrompt;
      });
    } catch (err: any) {
      if (err.code === 11000 && err.keyPattern?.slug) {
        throw new HttpError(
          400,
          `A prompt with slug '${slug}' already exists in this workspace.`,
        );
      }
      throw err;
    }
  }

  public async updatePrompt(
    workspaceId: string,
    userId: string,
    promptId: string,
    payload: UpdatePromptPayload,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);

    return runInTransaction(async (session) => {
      let targetPrompt = await PromptLibraryModel.findOne({
        _id: promptId,
        workspaceId,
      }).session(session || null);

      if (!targetPrompt) {
        throw new HttpError(404, "Prompt not found.");
      }

      await promptAuthorizationService.assertPromptAccess(
        targetPrompt,
        userId,
        workspaceId,
      );

      const rootPromptId = targetPrompt.parentId || targetPrompt._id;

      if (!targetPrompt.isLatest) {
        const latestDoc = await PromptLibraryModel.findOne({
          $or: [{ _id: rootPromptId }, { parentId: rootPromptId }],
          isLatest: true,
        }).session(session || null);

        if (latestDoc && latestDoc.isLatest) {
          targetPrompt = latestDoc;
        } else {
          throw new HttpError(
            400,
            "Historical prompt revisions are immutable. Update the current logical prompt/revision instead.",
          );
        }
      }

      let existing = targetPrompt;

      if (payload.folderId !== undefined && payload.folderId !== null) {
        const folder = await PromptFolderModel.findOne({
          _id: payload.folderId,
          workspaceId,
        }).session(session || null);
        if (!folder) {
          throw new HttpError(400, "Folder does not exist in this workspace.");
        }
      }

      if (payload.projectId !== undefined && payload.projectId !== null) {
        const project = await ProjectModel.findOne({
          _id: payload.projectId,
          workspaceId,
        }).session(session || null);
        if (!project) {
          throw new HttpError(400, "Project does not exist in this workspace.");
        }
      }

      const newBody = payload.body !== undefined ? payload.body : existing.body;
      const newMessages =
        payload.messages !== undefined
          ? payload.messages
          : existing.messages || [];
      const syncedVars = promptVariableService.syncVariables(
        newBody,
        newMessages,
        payload.variables !== undefined
          ? payload.variables
          : existing.variables,
      );
      const newProvider =
        payload.provider !== undefined
          ? payload.provider
          : existing.provider || "gemini";
      const newModelName =
        payload.modelName !== undefined
          ? payload.modelName
          : existing.modelName || "gemini-3.6-flash";
      const newParameters =
        payload.parameters !== undefined
          ? payload.parameters
          : existing.parameters || {
              temperature: 0.7,
              maxTokens: 2048,
              topP: 0.95,
              responseFormat: "text",
            };

      const newHash = promptHashService.generateCanonicalHash(
        newBody,
        newMessages,
        syncedVars,
        newProvider,
        newModelName,
        newParameters,
      );
      const contentChanged =
        existing.version === 0 || newHash !== existing.hash;

      // The first save of a new prompt is version 1. Creating a prompt already writes a placeholder
      // version 1 (its starting text), so while that placeholder has not been used, saving the person's
      // first real content replaces it instead of becoming version 2.
      if (
        contentChanged &&
        (await this.isUnusedPlaceholder(existing, rootPromptId, session))
      ) {
        await PromptVersionModel.updateOne(
          { promptId: rootPromptId, version: 1 },
          {
            $set: {
              hash: newHash,
              body: newBody,
              messages: newMessages,
              variables: syncedVars,
              provider: newProvider,
              modelName: newModelName,
              parameters: newParameters,
              changedBy: userId,
              // No longer the placeholder: the next content change is version 2.
              changeNote: payload.changeNote || "First saved version",
            },
          },
          { session },
        );
        if (payload.name !== undefined) existing.name = payload.name.trim();
        if (payload.description !== undefined)
          existing.description = payload.description;
        if (payload.category) existing.category = payload.category;
        if (payload.tags !== undefined)
          existing.tags = payload.tags.map((t) => t.toLowerCase().trim());
        if (payload.folderId !== undefined)
          existing.folderId = payload.folderId as any;
        if (payload.projectId !== undefined)
          existing.projectId = payload.projectId as any;
        if (payload.visibility) existing.visibility = payload.visibility;
        existing.body = newBody;
        existing.messages = newMessages as any;
        existing.variables = syncedVars as any;
        existing.provider = newProvider as any;
        existing.modelName = newModelName;
        existing.parameters = newParameters as any;
        existing.hash = newHash;
        await existing.save({ session: session || undefined });
        return existing;
      }

      if (contentChanged) {
        const latestVersionRecord = await PromptVersionModel.findOne({
          promptId: rootPromptId,
        })
          .sort({ version: -1 })
          .session(session || null);

        const newVersionNum =
          existing.version === 0
            ? 1
            : (latestVersionRecord?.version || existing.version) + 1;

        const updateRes = await PromptLibraryModel.updateOne(
          { _id: existing._id, isLatest: true },
          { $set: { isLatest: false } },
          { session },
        );

        if (updateRes.modifiedCount === 0) {
          const freshActive = await PromptLibraryModel.findOne({
            workspaceId,
            isLatest: true,
            $or: [{ _id: rootPromptId }, { parentId: rootPromptId }],
          }).session(session || null);

          if (freshActive) {
            existing = freshActive;
            await PromptLibraryModel.updateOne(
              { _id: existing._id, isLatest: true },
              { $set: { isLatest: false } },
            );
          }
        }

        const stableSlug =
          existing.slug || promptHashService.generateSlug(existing.name);

        const updatedPromptDocs = await PromptLibraryModel.create(
          [
            {
              workspaceId,
              parentId: rootPromptId,
              projectId:
                payload.projectId !== undefined
                  ? payload.projectId
                  : existing.projectId,
              name:
                payload.name !== undefined
                  ? payload.name.trim()
                  : existing.name,
              slug: stableSlug,
              description:
                payload.description !== undefined
                  ? payload.description
                  : existing.description,
              category: payload.category || existing.category,
              tags:
                payload.tags !== undefined
                  ? payload.tags.map((t) => t.toLowerCase().trim())
                  : existing.tags,
              body: newBody,
              messages: newMessages,
              variables: syncedVars,
              provider: newProvider,
              modelName: newModelName,
              parameters: newParameters,
              folderId:
                payload.folderId !== undefined
                  ? payload.folderId
                  : existing.folderId,
              visibility: payload.visibility || existing.visibility,
              createdBy: userId,
              version: newVersionNum,
              hash: newHash,
              isLatest: true,
            },
          ],
          { session },
        );

        const updatedPrompt = updatedPromptDocs[0];

        await PromptVersionModel.create(
          [
            {
              promptId: rootPromptId,
              version: newVersionNum,
              environment: "development",
              hash: newHash,
              body: newBody,
              messages: newMessages,
              variables: syncedVars,
              provider: newProvider,
              modelName: newModelName,
              parameters: newParameters,
              changedBy: userId,
              changeNote:
                payload.changeNote || `Updated prompt to v${newVersionNum}`,
            },
          ],
          { session },
        );

        return updatedPrompt;
      } else {
        if (payload.name !== undefined) existing.name = payload.name.trim();
        if (payload.description !== undefined)
          existing.description = payload.description;
        if (payload.category) existing.category = payload.category;
        if (payload.tags !== undefined)
          existing.tags = payload.tags.map((t) => t.toLowerCase().trim());
        if (payload.folderId !== undefined)
          existing.folderId = payload.folderId as any;
        if (payload.projectId !== undefined)
          existing.projectId = payload.projectId as any;
        if (payload.visibility) existing.visibility = payload.visibility;

        await existing.save({ session: session || undefined });
        return existing;
      }
    });
  }

  /**
   * True while a prompt still has only the version 1 that creating it wrote, and nothing has used it:
   * no other version, no deployment event and no run. Only then may the first save take its place.
   */
  private async isUnusedPlaceholder(
    existing: { version: number; parentId?: unknown },
    rootPromptId: string | Types.ObjectId,
    session: any,
  ): Promise<boolean> {
    if (existing.version !== 1 || existing.parentId) return false;
    const versions = await PromptVersionModel.find({ promptId: rootPromptId })
      .select("version changeNote")
      .session(session || null)
      .lean();
    if (versions.length !== 1 || versions[0].version !== 1) return false;
    if (versions[0].changeNote !== "Initial prompt version 1") return false;
    const [events, runs] = await Promise.all([
      PromptDeploymentEventModel.countDocuments({
        promptId: rootPromptId,
      }).session(session || null),
      PromptExecutionLogModel.countDocuments({
        promptId: rootPromptId,
      }).session(session || null),
    ]);
    return events === 0 && runs === 0;
  }

  public async deletePrompt(
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
    await PromptLibraryModel.updateMany(
      { workspaceId, $or: [{ _id: rootId }, { parentId: rootId }] },
      { $set: { isArchived: true } },
    );
    return { success: true };
  }
}

export default new PromptService();
