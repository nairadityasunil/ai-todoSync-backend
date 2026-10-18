import PromptFavoriteModel from "../models/prompt-favorite.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import promptAuthorizationService from "./prompt-authorization.service.js";
import workspaceService from "../../workspace/services/workspace.service.js";

import { HttpError } from "../../../shared/errors/http-error.js";
import { escapeRegex } from "../../../utils/escape-regex.js";

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
    } = {},
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
    const filter: Record<string, any> = {
      workspaceId,
      isLatest: true,
      isArchived: false,
    };

    filter.$or = [
      { visibility: "organization" },
      { createdBy: userId },
      { visibility: "project" },
    ];

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

    const prompts = await PromptLibraryModel.find(filter)
      .sort({ updatedAt: -1 })
      .populate("createdBy", "name email avatar")
      .lean();

    const accessiblePrompts: any[] = [];
    for (const p of prompts) {
      try {
        await promptAuthorizationService.assertPromptAccess(
          p,
          userId,
          workspaceId,
        );
        accessiblePrompts.push(p);
      } catch (_e) {
        // Skip prompts caller cannot access
      }
    }

    const userFavs = new Set(
      (await PromptFavoriteModel.find({ workspaceId, userId }).lean()).map(
        (f) => f.promptId.toString(),
      ),
    );

    return accessiblePrompts.map((p) => {
      const rootId = p.parentId ? p.parentId.toString() : p._id.toString();
      return {
        ...p,
        isFavorite: userFavs.has(p._id.toString()) || userFavs.has(rootId),
      };
    });
  }

  public async getPromptDetails(
    workspaceId: string,
    userId: string,
    promptId: string,
  ) {
    await workspaceService.assertMembership(userId, workspaceId);
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

    return {
      ...prompt,
      isFavorite: favCount > 0,
    };
  }
}

export default new PromptQueryService();
