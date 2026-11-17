import PromptFavoriteModel from "../models/prompt-favorite.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
import PromptCanaryDeploymentModel from "../models/prompt-canary-deployment.model.js";
import projectService from "../../project/services/project.service.js";
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

  /**
   * Prompts a person can run from a project: those with a version deployed to production
   * (with its variables and any canary under way), deployed ones first. Prompts that were
   * never deployed are left out unless `includeUndeployed` is set.
   */
  public async listRunnable(
    workspaceId: string,
    userId: string,
    options: {
      projectId?: string;
      search?: string;
      includeUndeployed?: boolean;
    } = {},
  ) {
    if (options.projectId)
      await projectService.assertProjectMembership(userId, options.projectId);
    const prompts = await this.listPrompts(workspaceId, userId, {
      search: options.search,
    });
    const rootOf = (p: any) =>
      p.parentId ? p.parentId.toString() : p._id.toString();
    const rootIds = [...new Set(prompts.map(rootOf))];
    const [prodVersions, canaries] = await Promise.all([
      PromptVersionModel.find({
        promptId: { $in: rootIds },
        environment: "production",
      })
        .sort({ version: -1 })
        .lean(),
      PromptCanaryDeploymentModel.find({
        promptId: { $in: rootIds },
        status: { $in: ["active", "paused"] },
      }).lean(),
    ]);
    const prodByRoot = new Map<string, any>();
    for (const v of prodVersions)
      if (!prodByRoot.has(String(v.promptId)))
        prodByRoot.set(String(v.promptId), v);
    const canaryByRoot = new Map(canaries.map((c) => [String(c.promptId), c]));

    const rows = prompts.map((p: any) => {
      const root = rootOf(p);
      const prod = prodByRoot.get(root);
      const canary = canaryByRoot.get(root);
      return {
        id: String(p._id),
        rootId: root,
        name: p.name,
        description: p.description || "",
        category: p.category || "general",
        tags: p.tags || [],
        folderId: p.folderId ? String(p.folderId) : null,
        deployed: Boolean(prod),
        productionVersion: prod?.version ?? p.productionVersion ?? 1,
        provider: prod?.provider ?? p.provider,
        modelName: prod?.modelName ?? p.modelName,
        // The variables of the version that will run.
        variables: (prod?.variables ?? p.variables ?? []).map((v: any) => ({
          name: v.name,
          type: v.type || "string",
          description: v.description || "",
          defaultValue: v.defaultValue ?? "",
          required: Boolean(v.required),
          options: v.options || [],
        })),
        canary: canary
          ? {
              status: canary.status,
              candidateVersion: canary.candidateVersion,
              canaryPercent: canary.trafficWeight?.canary ?? 0,
            }
          : null,
        updatedAt: p.updatedAt,
      };
    });
    return rows
      .filter((r) => options.includeUndeployed || r.deployed)
      .sort(
        (a, b) =>
          Number(b.deployed) - Number(a.deployed) ||
          a.name.localeCompare(b.name),
      );
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
