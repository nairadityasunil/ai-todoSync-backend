import PromptFolderModel from "../models/prompt-folder.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
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
import promptDeploymentService from "./prompt-deployment.service.js";
import type {
  CreatePromptPayload,
  UpdatePromptPayload,
} from "../../../interfaces/prompt/prompt.interface.js";

import { HttpError } from "../../../shared/errors/http-error.js";
import {
  resolveProjectObjectId,
  resolveProjectUuid,
} from "../../../utils/project-id.js";

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
  public runPlayground = promptPlaygroundService.runPlayground;

  // Deployment Operations (production / canary / feature binding)
  public listFeatures = promptDeploymentService.listFeatures.bind(
    promptDeploymentService,
  );
  public getDeployment = promptDeploymentService.getDeployment.bind(
    promptDeploymentService,
  );
  public setProductionVersion = promptDeploymentService.setProduction.bind(
    promptDeploymentService,
  );
  public startCanary = promptDeploymentService.startCanary.bind(
    promptDeploymentService,
  );
  public deployVersion = promptDeploymentService.deploy.bind(
    promptDeploymentService,
  );
  public rollbackProduction = promptDeploymentService.rollback.bind(
    promptDeploymentService,
  );
  public promoteCanary = promptDeploymentService.promoteCanary.bind(
    promptDeploymentService,
  );
  public abortCanary = promptDeploymentService.abortCanary.bind(
    promptDeploymentService,
  );
  public bindFeature = promptDeploymentService.bindFeature.bind(
    promptDeploymentService,
  );

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
      await promptAuthorizationService.assertCanAttachProject(
        userId,
        workspaceId,
        String(payload.projectId),
      );
    }

    const bodyText = payload.body || "";
    const messages = payload.messages || [];
    const syncedVariables = promptVariableService.syncVariables(
      bodyText,
      messages,
      payload.variables,
    );
    const hash = promptHashService.generateCanonicalHash(
      bodyText,
      messages,
      syncedVariables,
      payload.parameters,
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
      const resolvedProjectId = payload.projectId
        ? (await resolveProjectObjectId(payload.projectId)) || payload.projectId
        : null;

      return await runInTransaction(async (session) => {
        const promptDocs = await PromptLibraryModel.create(
          [
            {
              workspaceId,
              projectId: resolvedProjectId,
              name: payload.name.trim(),
              slug,
              description: payload.description || "",
              category: payload.category || "general",
              tags: (payload.tags || []).map((t) => t.toLowerCase().trim()),
              body: bodyText,
              messages,
              variables: syncedVariables,
              parameters: payload.parameters,
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

        const prompt = promptDocs[0];

        await PromptVersionModel.create(
          [
            {
              promptId: prompt._id,
              version: 1,
              hash,
              body: bodyText,
              messages,
              variables: syncedVariables,
              parameters: payload.parameters,
              changedBy: userId,
              changeNote: "Initial prompt creation (v1)",
            },
          ],
          { session },
        );

        await promptDeploymentService.ensureDeployment(
          workspaceId,
          prompt._id,
          1,
          userId,
          session,
        );

        const rawPid = prompt.projectId ? prompt.projectId.toString() : null;
        const projectUuid = rawPid
          ? (await resolveProjectUuid(rawPid)) || rawPid
          : null;
        const promptObj = prompt.toObject ? prompt.toObject() : prompt;
        return { ...promptObj, projectId: projectUuid };
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
      const targetPrompt = await PromptLibraryModel.findOne({
        _id: promptId,
        workspaceId,
      }).session(session || null);

      if (!targetPrompt) {
        throw new HttpError(404, "Prompt not found.");
      }

      await promptAuthorizationService.assertCanEdit(
        targetPrompt,
        userId,
        workspaceId,
      );

      if (!targetPrompt.isLatest) {
        throw new HttpError(
          400,
          "Historical prompt revisions are immutable. Update the current logical prompt/revision instead.",
        );
      }

      const rootPromptId = targetPrompt.parentId || targetPrompt._id;
      let existing = targetPrompt;

      const resolvedProjectId =
        payload.projectId !== undefined
          ? payload.projectId
            ? (await resolveProjectObjectId(payload.projectId)) ||
              payload.projectId
            : null
          : undefined;

      if (payload.folderId !== undefined && payload.folderId !== null) {
        const folder = await PromptFolderModel.findOne({
          _id: payload.folderId,
          workspaceId,
        }).session(session || null);
        if (!folder) {
          throw new HttpError(400, "Folder does not exist in this workspace.");
        }
      }

      if (
        payload.projectId !== undefined &&
        payload.projectId !== null &&
        String(payload.projectId) !== String(existing.projectId ?? "")
      ) {
        await promptAuthorizationService.assertCanAttachProject(
          userId,
          workspaceId,
          String(payload.projectId),
        );
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

      const newHash = promptHashService.generateCanonicalHash(
        newBody,
        newMessages,
        syncedVars,
        payload.parameters !== undefined
          ? payload.parameters
          : existing.parameters,
      );
      const contentChanged = newHash !== existing.hash;

      if (contentChanged) {
        const latestVersionRecord = await PromptVersionModel.findOne({
          promptId: rootPromptId,
        })
          .sort({ version: -1 })
          .session(session || null);

        const currentVersionNum =
          latestVersionRecord?.version || existing.version;
        const newVersionNum = currentVersionNum + 1;

        // Editing creates a new version but never changes what is deployed:
        // pin production to the current version if it was not pinned yet.
        await promptDeploymentService.ensureDeployment(
          workspaceId,
          rootPromptId,
          currentVersionNum,
          userId,
          session,
        );

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

        const nextParams =
          payload.parameters !== undefined
            ? payload.parameters
            : existing.parameters;

        const updatedPromptDocs = await PromptLibraryModel.create(
          [
            {
              workspaceId,
              parentId: rootPromptId,
              projectId:
                resolvedProjectId !== undefined
                  ? resolvedProjectId
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
              parameters: nextParams,
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
              hash: newHash,
              body: newBody,
              messages: newMessages,
              variables: syncedVars,
              parameters: nextParams,
              changedBy: userId,
              changeNote:
                payload.changeNote || `Updated prompt to v${newVersionNum}`,
            },
          ],
          { session },
        );

        const rawUpdatedPid = updatedPrompt.projectId
          ? updatedPrompt.projectId.toString()
          : null;
        const updatedProjectUuid = rawUpdatedPid
          ? (await resolveProjectUuid(rawUpdatedPid)) || rawUpdatedPid
          : null;
        const updatedObj = updatedPrompt.toObject
          ? updatedPrompt.toObject()
          : updatedPrompt;
        return { ...updatedObj, projectId: updatedProjectUuid };
      } else {
        if (payload.name !== undefined) existing.name = payload.name.trim();
        if (payload.description !== undefined)
          existing.description = payload.description;
        if (payload.category) existing.category = payload.category;
        if (payload.tags !== undefined)
          existing.tags = payload.tags.map((t) => t.toLowerCase().trim());
        if (payload.folderId !== undefined)
          existing.folderId = payload.folderId as any;
        if (resolvedProjectId !== undefined)
          existing.projectId = resolvedProjectId as any;
        if (payload.visibility) existing.visibility = payload.visibility;
        if (payload.parameters !== undefined)
          existing.parameters = payload.parameters as any;

        await existing.save({ session: session || undefined });

        const rawExistingPid = existing.projectId
          ? existing.projectId.toString()
          : null;
        const existingProjectUuid = rawExistingPid
          ? (await resolveProjectUuid(rawExistingPid)) || rawExistingPid
          : null;
        const existingObj = existing.toObject ? existing.toObject() : existing;
        return { ...existingObj, projectId: existingProjectUuid };
      }
    });
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
    await promptAuthorizationService.assertCanEdit(prompt, userId, workspaceId);

    const rootId = prompt.parentId || prompt._id;
    await PromptLibraryModel.updateMany(
      { workspaceId, $or: [{ _id: rootId }, { parentId: rootId }] },
      { $set: { isArchived: true } },
    );
    await promptDeploymentService.retire(workspaceId, rootId, userId);
    return { success: true };
  }
}

export default new PromptService();
