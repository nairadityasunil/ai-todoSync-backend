import { randomUUID } from "crypto";
import llmCatalogService from "./llm-catalog.service.js";
import costControlService from "./cost-control.service.js";
import PromptExecutionLogModel from "../../prompt/models/prompt-execution-log.model.js";
import promptVersionResolverService from "../../prompt/services/prompt-version-resolver.service.js";
import promptCanaryService from "../../prompt/services/prompt-canary.service.js";
import { GeminiAdapter } from "../adapters/gemini.adapter.js";
import { OpenAIAdapter } from "../adapters/openai.adapter.js";
import { AnthropicAdapter } from "../adapters/anthropic.adapter.js";
import { GenericOpenAIAdapter } from "../adapters/generic-openai.adapter.js";
import type {
  ILlmProviderAdapter,
  LlmExecutionOptions,
  LlmMessage,
  LlmNormalizedResponse,
} from "../adapters/base.adapter.js";
import { HttpError } from "../../../shared/errors/http-error.js";
import logger from "../../../lib/logger.js";
import { governAiCall } from "../../agents/ai-governance.js";
import { currentAgent } from "../../agents/activity.service.js";
import costService from "../../agents/cost.service.js";

export interface LlmExecutionPayload {
  workspaceId: string;
  userId: string;
  projectId?: string | null;
  promptId?: string | null;
  promptVersion?: number | null;
  isProduction?: boolean;
  source: "playground" | "project_ai" | "mcp" | "ai_planner" | "system";
  messages: LlmMessage[];
  provider?: string;
  modelName?: string;
  parameters?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    responseFormat?: "text" | "json";
  };
  userApiKey?: string;
  baseUrl?: string;
}

export interface LlmExecutionResult extends LlmNormalizedResponse {
  requestId: string;
  provider: string;
  modelName: string;
  latencyMs: number;
  cost: {
    inputCost: number;
    outputCost: number;
    cachedCost: number;
    totalCost: number;
  };
  executedVersion?: number;
  isCanary?: boolean;
}

export class LlmExecutionService {
  private readonly adapters: Record<string, ILlmProviderAdapter> = {
    gemini: new GeminiAdapter(),
    openai: new OpenAIAdapter(),
    anthropic: new AnthropicAdapter(),
    groq: new GenericOpenAIAdapter(),
    ollama: new GenericOpenAIAdapter(),
  };

  public async execute(
    payload: LlmExecutionPayload,
  ): Promise<LlmExecutionResult> {
    const requestId = `req_${randomUUID().slice(0, 12)}`;
    const startTime = Date.now();
    // Who is spending: the agent behind this request, if any.
    const agentId = currentAgent()?.id ?? null;

    // 1. Budget check
    await costControlService.assertWorkspaceBudget(payload.workspaceId);

    let executedVersionNumber = payload.promptVersion ?? undefined;
    let isCanaryExecution = false;
    let activeCanaryId: string | null = null;
    let effectiveProvider = payload.provider;
    let effectiveModelName = payload.modelName;
    let effectiveParameters = payload.parameters;

    // 2. Version Resolution & Canary Routing
    if (payload.promptId) {
      try {
        const resolved = await promptVersionResolverService.resolveVersion(
          payload.promptId,
          {
            isProduction: payload.isProduction,
            requestedVersion: payload.promptVersion || undefined,
          },
        );

        executedVersionNumber = resolved.versionNumber;
        isCanaryExecution = resolved.isCanary;
        activeCanaryId = resolved.canaryDeploymentId || null;

        // Apply version parameters if not explicitly provided
        if (!effectiveProvider && resolved.version.provider) {
          effectiveProvider = resolved.version.provider;
        }
        if (!effectiveModelName && resolved.version.modelName) {
          effectiveModelName = resolved.version.modelName;
        }
        if (!effectiveParameters && resolved.version.parameters) {
          effectiveParameters = resolved.version.parameters as any;
        }
      } catch (err) {
        logger.warn("Version resolution fallback to payload values", { err });
      }
    }

    // 3. Resolve Model & Provider
    let selectedModel = await llmCatalogService.getModelDetails(
      effectiveModelName || "",
    );
    if (!selectedModel) {
      selectedModel = await llmCatalogService.getDefaultModel();
    }

    const providerId = (
      effectiveProvider ||
      selectedModel.providerId ||
      "gemini"
    ).toLowerCase();
    const modelId = selectedModel.modelId;

    // 4. Resolve Adapter
    const adapter = this.adapters[providerId] || this.adapters["gemini"];

    const execOptions: LlmExecutionOptions = {
      modelId,
      temperature: effectiveParameters?.temperature,
      maxTokens: effectiveParameters?.maxTokens,
      topP: effectiveParameters?.topP,
      frequencyPenalty: effectiveParameters?.frequencyPenalty,
      presencePenalty: effectiveParameters?.presencePenalty,
      responseFormat: effectiveParameters?.responseFormat,
      userApiKey: payload.userApiKey,
      baseUrl: payload.baseUrl,
    };

    // 5. Agent governance: provider kill switch, policies and data masking.
    const governed = await governAiCall({
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      projectId: payload.projectId,
      providerId,
      source: payload.source,
      messages: payload.messages,
    });

    try {
      // 6. Execute LLM call
      const response = await adapter.execute(governed.messages, execOptions);
      const latencyMs = Date.now() - startTime;

      // 6. Calculate Cost
      const cost = costControlService.calculateCost(
        selectedModel,
        response.inputTokens,
        response.outputTokens,
        response.cachedTokens,
      );

      // 7. Log Execution
      await PromptExecutionLogModel.create({
        requestId,
        workspaceId: payload.workspaceId,
        projectId: payload.projectId || null,
        userId: payload.userId,
        agentId,
        promptId: payload.promptId || null,
        promptVersion: executedVersionNumber || null,
        isProduction: payload.isProduction || false,
        isCanary: isCanaryExecution,
        canaryDeploymentId: activeCanaryId || null,
        source: payload.source,
        provider: providerId,
        modelName: modelId,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cachedTokens: response.cachedTokens,
        totalTokens: response.totalTokens,
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        totalCost: cost.totalCost,
        latencyMs,
        status: "success",
      }).catch((err) => {
        logger.error("Failed to persist execution log", { err });
      });
      void costService.recordSpend({
        workspaceId: String(payload.workspaceId),
        costUsd: cost.totalCost,
        providerAgentId: governed.agent?._id.toString() ?? null,
      });

      // 8. Record Canary Metrics
      if (activeCanaryId) {
        promptCanaryService.recordExecutionMetrics(
          activeCanaryId,
          isCanaryExecution,
          false,
          latencyMs,
          response.totalTokens,
          cost.totalCost,
        );
      }

      return {
        ...response,
        requestId,
        provider: providerId,
        modelName: modelId,
        latencyMs,
        cost,
        executedVersion: executedVersionNumber,
        isCanary: isCanaryExecution,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const errorCategory = this.categorizeError(err);
      const errorMessage = err?.message || "LLM execution failed";

      await PromptExecutionLogModel.create({
        requestId,
        workspaceId: payload.workspaceId,
        projectId: payload.projectId || null,
        userId: payload.userId,
        agentId,
        promptId: payload.promptId || null,
        promptVersion: executedVersionNumber || null,
        isProduction: payload.isProduction || false,
        isCanary: isCanaryExecution,
        canaryDeploymentId: activeCanaryId || null,
        source: payload.source,
        provider: providerId,
        modelName: modelId,
        latencyMs,
        status: "error",
        errorCategory,
        errorMessage,
      }).catch((logErr) => {
        logger.error("Failed to log error execution", { logErr });
      });

      if (activeCanaryId) {
        promptCanaryService.recordExecutionMetrics(
          activeCanaryId,
          isCanaryExecution,
          true,
          latencyMs,
          0,
          0,
        );
      }

      throw new HttpError(
        errorCategory === "budget_exceeded" ? 429 : 502,
        `LLM Execution Error [${errorCategory}]: ${errorMessage}`,
      );
    }
  }

  private categorizeError(err: any): string {
    const msg = String(err?.message || "").toLowerCase();
    if (msg.includes("budget") || msg.includes("quota"))
      return "budget_exceeded";
    if (
      msg.includes("401") ||
      msg.includes("api key") ||
      msg.includes("unauthorized")
    )
      return "invalid_credentials";
    if (msg.includes("429") || msg.includes("rate limit"))
      return "rate_limited";
    if (msg.includes("context length") || msg.includes("maximum context"))
      return "context_length_exceeded";
    if (msg.includes("timeout") || msg.includes("aborted")) return "timeout";
    return "provider_error";
  }
}

export default new LlmExecutionService();
