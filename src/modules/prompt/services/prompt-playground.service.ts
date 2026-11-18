import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
import promptAuthorizationService from "./prompt-authorization.service.js";
import promptVariableService from "./prompt-variable.service.js";
import workspaceService from "../../workspace/services/workspace.service.js";
import projectService from "../../project/services/project.service.js";
import UserModel from "../../auth/models/user.model.js";
import env from "../../../config/env.js";
import llmExecutionService from "../../ai/services/llm-execution.service.js";
import promptVersionResolverService from "./prompt-version-resolver.service.js";
import { HttpError } from "../../../shared/errors/http-error.js";
import type {
  IPromptVariable,
  IPromptMessage,
} from "../../../interfaces/prompt/prompt.interface.js";

export interface PlaygroundRunPayload {
  promptId?: string;
  /** The project the run is for (a person's own project work); the run is then recorded as project AI. */
  projectId?: string;
  versionNumber?: number;
  /**
   * "production" runs what is deployed: the production version, or the canary
   * candidate for the share of calls a canary sends to it. Without it the run
   * uses the draft in the library (or `versionNumber`), as the editor does.
   */
  environment?: "production";
  body?: string;
  messages?: IPromptMessage[];
  variables?: Record<string, any>;
  modelName?: string;
  provider?: "gemini" | "openai" | "anthropic";
  parameters?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
}

export interface PlaygroundRunResponse {
  output: string;
  resolvedPrompt: string | IPromptMessage[];
  metadata: {
    modelName: string;
    provider: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    timestamp: string;
    promptId?: string;
    versionNumber?: number;
    environment?: "production";
    isCanary?: boolean;
  };
}

/**
 * The key to call the provider with: the person's own key for that provider (Settings → AI providers),
 * else, for Gemini, the server's key. Without this the run is refused as "API key is missing".
 */
async function resolveProviderKey(
  userId: string,
  provider: string,
): Promise<string> {
  const user = await UserModel.findById(userId)
    .select("openaiApiKey anthropicApiKey geminiApiKey")
    .exec();
  const own =
    provider === "openai"
      ? user?.openaiApiKey
      : provider === "anthropic"
        ? user?.anthropicApiKey
        : user?.geminiApiKey;
  const key =
    own?.trim() ||
    (provider === "gemini" ? env.GEMINI_API_KEY?.trim() : "") ||
    "";
  if (!key) {
    const name =
      provider === "openai"
        ? "OpenAI"
        : provider === "anthropic"
          ? "Anthropic"
          : "Google Gemini";
    throw new HttpError(
      400,
      `No API key for ${name} yet. Add yours under Settings → Profile → AI providers.`,
    );
  }
  return key;
}

export class PromptPlaygroundService {
  public async runPlayground(
    workspaceId: string,
    userId: string,
    payload: PlaygroundRunPayload,
  ): Promise<PlaygroundRunResponse> {
    await workspaceService.assertMembership(userId, workspaceId);
    if (payload.projectId)
      await projectService.assertProjectMembership(userId, payload.projectId);

    let templateBody = payload.body || "";
    let templateMessages: IPromptMessage[] = payload.messages || [];
    let promptVariables: IPromptVariable[] = [];
    let versionNum = payload.versionNumber;
    let served: {
      versionNumber: number;
      isCanary: boolean;
      canaryDeploymentId?: string | null;
    } | null = null;
    let servedModel: {
      provider?: string;
      modelName?: string;
      parameters?: Record<string, unknown> | null;
    } = {};

    if (
      payload.environment !== undefined &&
      payload.environment !== "production"
    ) {
      throw new HttpError(400, 'environment must be "production".');
    }
    if (payload.environment === "production" && !payload.promptId) {
      throw new HttpError(
        400,
        "promptId is required to run the deployed version.",
      );
    }
    if (payload.environment === "production" && payload.versionNumber) {
      throw new HttpError(
        400,
        "Choose either environment or versionNumber, not both.",
      );
    }

    if (payload.promptId) {
      const promptDoc = await PromptLibraryModel.findOne({
        _id: payload.promptId,
        workspaceId,
      });

      if (!promptDoc) {
        throw new HttpError(404, "Prompt template not found in workspace.");
      }

      await promptAuthorizationService.assertPromptAccess(
        promptDoc,
        userId,
        workspaceId,
      );

      if (payload.environment === "production") {
        // The deployed version, with the canary split applied: this is the call a canary measures.
        const resolved = await promptVersionResolverService.resolveVersion(
          payload.promptId,
        );
        served = {
          versionNumber: resolved.versionNumber,
          isCanary: resolved.isCanary,
          canaryDeploymentId: resolved.canaryDeploymentId ?? null,
        };
        versionNum = resolved.versionNumber;
        templateBody = resolved.version.body || "";
        templateMessages = resolved.version.messages || [];
        promptVariables = resolved.version.variables || [];
        servedModel = {
          provider: resolved.version.provider ?? undefined,
          modelName: resolved.version.modelName ?? undefined,
          parameters:
            (resolved.version.parameters as unknown as Record<
              string,
              unknown
            >) ?? null,
        };
      } else if (versionNum) {
        const verDoc = await PromptVersionModel.findOne({
          promptId: payload.promptId,
          version: versionNum,
        });
        if (!verDoc) {
          throw new HttpError(
            404,
            `Version ${versionNum} not found for this prompt.`,
          );
        }
        templateBody = verDoc.body || "";
        templateMessages = verDoc.messages || [];
        promptVariables = verDoc.variables || [];
      } else {
        versionNum = promptDoc.version;
        templateBody = promptDoc.body || "";
        templateMessages = promptDoc.messages || [];
        promptVariables = promptDoc.variables || [];
      }
    }

    const syncedVariables = promptVariableService.syncVariables(
      templateBody,
      templateMessages,
      promptVariables,
    );

    const suppliedValues = payload.variables || {};
    promptVariableService.validateVariableValues(
      syncedVariables,
      suppliedValues,
    );

    const resolved = promptVariableService.substituteVariables(
      templateBody,
      syncedVariables,
      suppliedValues,
    );

    let aiMessages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [];
    if (Array.isArray(resolved)) {
      aiMessages = resolved.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      }));
    } else {
      aiMessages = [{ role: "user", content: resolved as string }];
    }

    const selectedProvider =
      payload.provider ||
      (servedModel.provider as typeof payload.provider) ||
      "gemini";
    const selectedModel =
      payload.modelName || servedModel.modelName || "gemini-3.6-flash";
    const versionParams = (servedModel.parameters ?? {}) as {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
    };

    const userApiKey = await resolveProviderKey(userId, selectedProvider);
    const execResult = await llmExecutionService.execute({
      workspaceId,
      userId,
      promptId: payload.promptId || null,
      // A deployed run is resolved above, once; the execution must not draw the canary split again.
      promptVersion: served ? null : versionNum || null,
      resolved: served ?? undefined,
      userApiKey,
      projectId: payload.projectId ?? null,
      source: payload.projectId ? "project_ai" : "playground",
      messages: aiMessages,
      provider: selectedProvider,
      modelName: selectedModel,
      parameters: {
        temperature:
          payload.parameters?.temperature ?? versionParams.temperature ?? 0.7,
        maxTokens:
          payload.parameters?.maxTokens ?? versionParams.maxTokens ?? 2048,
        topP: payload.parameters?.topP ?? versionParams.topP ?? 0.95,
      },
    });

    return {
      output: execResult.content,
      resolvedPrompt: resolved as string | IPromptMessage[],
      metadata: {
        modelName: execResult.modelName,
        provider: execResult.provider,
        latencyMs: execResult.latencyMs,
        inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens,
        totalTokens: execResult.totalTokens,
        costUsd: execResult.cost.totalCost,
        timestamp: new Date().toISOString(),
        promptId: payload.promptId,
        versionNumber: versionNum,
        ...(served
          ? { environment: "production" as const, isCanary: served.isCanary }
          : {}),
      },
    };
  }
}

export default new PromptPlaygroundService();
