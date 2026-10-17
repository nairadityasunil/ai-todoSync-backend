import PromptFavoriteModel from "../models/prompt-favorite.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import promptAuthorizationService from "./prompt-authorization.service.js";
import promptDeploymentService from "./prompt-deployment.service.js";
import accessService from "../../access/access.service.js";
import { escapeRegex } from "../../../shared/environment.js";

import { HttpError } from "../../../shared/errors/http-error.js";
import {
  buildProjectUuidMap,
  resolveProjectUuid,
} from "../../../utils/project-id.js";

export class PromptQueryService {
  public async listPrompts(
    workspaceId: string,
    userId: string,
    options: {
      category?: string;
      folderId?: string;
      search?: string;
      isTemplate?: boolean;
      isFavorite?: boolean;
      /** Only prompts linked to this project (the project's Prompts tab). */
      projectId?: string;
    } = {},
  ) {
    const access = await accessService.resolve(userId, workspaceId);
    let resolvedProjectOid: any = undefined;
    if (options.projectId) {
      const project = await accessService.assertProject(
        access,
        options.projectId,
      );
      resolvedProjectOid = project._id;
    }
    // Visibility is decided in the query, so no per-prompt checks are needed.
    const filter: Record<string, any> = {
      ...(await accessService.promptVisibilityFilter(access)),
      isLatest: true,
      isArchived: false,
    };
    if (resolvedProjectOid) filter.projectId = resolvedProjectOid;

    if (options.category) filter.category = options.category;

    if (options.folderId !== undefined) {
      filter.folderId = options.folderId === "null" ? null : options.folderId;
    }

    if (typeof options.isTemplate === "boolean") {
      filter.isTemplate = options.isTemplate;
    }

    if (typeof options.isFavorite === "boolean") {
      const userFavDocs = await PromptFavoriteModel.find({
        workspaceId,
        userId,
      }).lean();
      const favoritePromptIds = userFavDocs.map((f) => f.promptId.toString());

      if (options.isFavorite) {
        filter._id = { $in: favoritePromptIds };
      } else {
        filter._id = { $nin: favoritePromptIds };
      }
    }

    if (options.search && options.search.trim()) {
      const searchRegex = new RegExp(escapeRegex(options.search.trim()), "i");
      const searchClause = [
        { name: searchRegex },
        { description: searchRegex },
        { tags: searchRegex },
        { body: searchRegex },
      ];
      filter.$and = [{ $or: searchClause }];
    }

    const accessiblePrompts: any[] = await PromptLibraryModel.find(filter)
      .sort({ updatedAt: -1 })
      .populate("createdBy", "name email avatar")
      .lean();

    const userFavs = new Set(
      (await PromptFavoriteModel.find({ workspaceId, userId }).lean()).map(
        (f) => f.promptId.toString(),
      ),
    );

    const deployments = await promptDeploymentService.getSummaries(
      workspaceId,
      accessiblePrompts.map((p) => p.parentId || p._id),
    );

    const rawProjectIds = accessiblePrompts
      .map((p) => (p.projectId ? p.projectId.toString() : null))
      .filter(Boolean) as string[];
    const uuidMap = await buildProjectUuidMap(rawProjectIds);

    return accessiblePrompts.map((p) => {
      const rootId = p.parentId ? p.parentId.toString() : p._id.toString();
      const rawPid = p.projectId ? p.projectId.toString() : null;
      const projectUuid = rawPid ? uuidMap.get(rawPid) || rawPid : null;
      return {
        ...p,
        projectId: projectUuid,
        isFavorite: userFavs.has(p._id.toString()) || userFavs.has(rootId),
        deployment: deployments.get(rootId) ?? null,
      };
    });
  }

  public async getPromptDetails(
    workspaceId: string,
    userId: string,
    promptId: string,
  ) {
    const prompt = await PromptLibraryModel.findOne({
      _id: promptId,
      workspaceId,
    })
      .populate("createdBy", "name email avatar")
      .lean();

    if (!prompt) {
      throw new HttpError(404, "Prompt not found.");
    }

    await promptAuthorizationService.assertPromptAccess(
      prompt,
      userId,
      workspaceId,
    );

    const rootId = prompt.parentId
      ? prompt.parentId.toString()
      : prompt._id.toString();
    const favCount = await PromptFavoriteModel.countDocuments({
      workspaceId,
      userId,
      promptId: { $in: [prompt._id, rootId] },
    });

    const deployments = await promptDeploymentService.getSummaries(
      workspaceId,
      [rootId],
    );

    const rawPid = prompt.projectId ? prompt.projectId.toString() : null;
    const projectUuid = rawPid
      ? (await resolveProjectUuid(rawPid)) || rawPid
      : null;

    return {
      ...prompt,
      projectId: projectUuid,
      isFavorite: favCount > 0,
      deployment: deployments.get(rootId) ?? null,
    };
  }
}

export default new PromptQueryService();
