import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import promptLibraryService, { HttpError } from "../services/prompt.service.js";

class PromptLibraryController {
  private getUserId(req: AuthenticatedRequest): string {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new HttpError(401, "Authentication required.");
    }
    return userId;
  }

  private getParam(req: AuthenticatedRequest, key: string): string {
    const val = req.params[key];
    if (!val || typeof val !== "string") {
      throw new HttpError(400, `Missing required param '${key}'`);
    }
    return val;
  }

  private parseBooleanQuery(val: unknown): boolean | undefined {
    if (val === undefined || val === null || val === "") return undefined;
    if (val === "true" || val === true) return true;
    if (val === "false" || val === false) return false;
    return undefined;
  }

  // Folders
  public createFolder = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");

      const folder = await promptLibraryService.createFolder(
        workspaceId,
        userId,
        req.body,
      );
      res.status(201).json({ status: "success", data: folder });
    } catch (err) {
      next(err);
    }
  };

  public listFolders = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");

      const folders = await promptLibraryService.listFolders(
        workspaceId,
        userId,
      );
      res.status(200).json({ status: "success", data: folders });
    } catch (err) {
      next(err);
    }
  };

  public updateFolder = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const folderId = this.getParam(req, "folderId");

      const folder = await promptLibraryService.updateFolder(
        workspaceId,
        userId,
        folderId,
        req.body,
      );
      res.status(200).json({ status: "success", data: folder });
    } catch (err) {
      next(err);
    }
  };

  public deleteFolder = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const folderId = this.getParam(req, "folderId");

      const result = await promptLibraryService.deleteFolder(
        workspaceId,
        userId,
        folderId,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  // Prompts
  public listPrompts = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");

      const { category, folderId, search, isTemplate, isFavorite } = req.query;

      const prompts = await promptLibraryService.listPrompts(
        workspaceId,
        userId,
        {
          category: category as string,
          folderId: folderId as string,
          search: search as string,
          isTemplate: this.parseBooleanQuery(isTemplate),
          isFavorite: this.parseBooleanQuery(isFavorite),
        },
      );

      res.status(200).json({ status: "success", data: prompts });
    } catch (err) {
      next(err);
    }
  };

  public getPromptDetails = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const prompt = await promptLibraryService.getPromptDetails(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: prompt });
    } catch (err) {
      next(err);
    }
  };

  public createPrompt = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");

      const prompt = await promptLibraryService.createPrompt(
        workspaceId,
        userId,
        req.body,
      );
      res.status(201).json({ status: "success", data: prompt });
    } catch (err) {
      next(err);
    }
  };

  public updatePrompt = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const prompt = await promptLibraryService.updatePrompt(
        workspaceId,
        userId,
        promptId,
        req.body,
      );
      res.status(200).json({ status: "success", data: prompt });
    } catch (err) {
      next(err);
    }
  };

  public getPromptVersions = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const versions = await promptLibraryService.getPromptVersions(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: versions });
    } catch (err) {
      next(err);
    }
  };

  public comparePromptVersions = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const v1 = parseInt(req.query.v1 as string, 10);
      const v2 = parseInt(req.query.v2 as string, 10);

      if (isNaN(v1) || isNaN(v2)) {
        throw new HttpError(400, "Query params v1 and v2 must be numbers.");
      }

      const diff = await promptLibraryService.comparePromptVersions(
        workspaceId,
        userId,
        promptId,
        v1,
        v2,
      );
      res.status(200).json({ status: "success", data: diff });
    } catch (err) {
      next(err);
    }
  };

  public toggleFavorite = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const result = await promptLibraryService.toggleFavorite(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public validatePromptVariables = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const prompt = await promptLibraryService.getPromptDetails(
        workspaceId,
        userId,
        promptId,
      );

      const validated = promptLibraryService.validateVariableValues(
        prompt.variables,
        req.body.variables || {},
      );

      res.status(200).json({ status: "success", data: validated });
    } catch (err) {
      next(err);
    }
  };

  public renderPrompt = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const prompt = await promptLibraryService.getPromptDetails(
        workspaceId,
        userId,
        promptId,
      );

      const target =
        prompt.messages && prompt.messages.length > 0
          ? prompt.messages
          : prompt.body;
      const rendered = promptLibraryService.substituteVariables(
        target,
        prompt.variables,
        req.body.variables || {},
      );

      res.status(200).json({ status: "success", data: rendered });
    } catch (err) {
      next(err);
    }
  };

  public deletePrompt = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const result = await promptLibraryService.deletePrompt(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public runPlayground = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = req.params.promptId;

      const payload = {
        ...req.body,
        promptId: promptId || req.body.promptId,
      };

      const result = await promptLibraryService.runPlayground(
        workspaceId,
        userId,
        payload,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public publishProductionVersion = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const versionNumber = Number(req.body.versionNumber || req.body.version);

      if (!versionNumber || isNaN(versionNumber)) {
        throw new HttpError(400, "Valid versionNumber is required.");
      }

      const result = await promptLibraryService.publishProductionVersion(
        workspaceId,
        userId,
        promptId,
        versionNumber,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public moveToStaging = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const versionNumber = Number(req.params.version || req.body.version);

      if (!versionNumber || isNaN(versionNumber)) {
        throw new HttpError(400, "Valid version number is required.");
      }

      const result = await promptLibraryService.moveToStaging(
        workspaceId,
        userId,
        promptId,
        versionNumber,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public moveToDevelopment = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const versionNumber = Number(req.params.version || req.body.version);

      if (!versionNumber || isNaN(versionNumber)) {
        throw new HttpError(400, "Valid version number is required.");
      }

      const result = await promptLibraryService.moveToDevelopment(
        workspaceId,
        userId,
        promptId,
        versionNumber,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public deployDirectToProduction = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const versionNumber = Number(req.body.versionNumber || req.body.version);

      if (!versionNumber || isNaN(versionNumber)) {
        throw new HttpError(400, "Valid versionNumber is required.");
      }

      const result = await promptLibraryService.deployDirectToProduction(
        workspaceId,
        userId,
        promptId,
        versionNumber,
      );
      res.status(200).json({ status: "success", data: result });
    } catch (err) {
      next(err);
    }
  };

  public startCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const candidateVersion = Number(req.body.candidateVersion);

      if (!candidateVersion || isNaN(candidateVersion)) {
        throw new HttpError(400, "Valid candidateVersion is required.");
      }

      const canary = await promptLibraryService.startCanary(
        workspaceId,
        userId,
        promptId,
        {
          candidateVersion,
          minRequests: req.body.minRequests,
          errorThreshold: req.body.errorThreshold,
          acknowledgeChecks: req.body.acknowledgeChecks === true,
        },
      );
      res.status(201).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public advanceCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const canary = await promptLibraryService.advanceCanary(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public pauseCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const canary = await promptLibraryService.pauseCanary(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public resumeCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const canary = await promptLibraryService.resumeCanary(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public rollbackCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const reason = req.body.reason || "Manual rollback";

      const canary = await promptLibraryService.rollbackCanary(
        workspaceId,
        userId,
        promptId,
        reason,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public cancelCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");
      const reason = req.body.reason || "Cancelled by user";

      const canary = await promptLibraryService.cancelCanary(
        workspaceId,
        userId,
        promptId,
        reason,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public completeCanary = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const canary = await promptLibraryService.completeCanary(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };

  public getCanaryDeployment = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = this.getUserId(req);
      const workspaceId = this.getParam(req, "workspaceId");
      const promptId = this.getParam(req, "promptId");

      const canary = await promptLibraryService.getCanaryDeployment(
        workspaceId,
        userId,
        promptId,
      );
      res.status(200).json({ status: "success", data: canary });
    } catch (err) {
      next(err);
    }
  };
}

export default new PromptLibraryController();
