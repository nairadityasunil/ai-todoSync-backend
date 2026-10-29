import type { LlmMessage } from "../ai/adapters/base.adapter.js";
import logger from "../../lib/logger.js";
import { HttpError } from "../../shared/errors/http-error.js";
import ProjectModel from "../project/models/project.model.js";
import WorkspaceModel from "../workspace/models/workspace.model.js";
import { Types } from "mongoose";
import { currentRequest } from "./request-context.js";
import activityService from "./activity.service.js";
import agentService, { agentBlockReason } from "./agent.service.js";
import { authorize } from "./guard.js";
import { AgentModel, type IAgentDocument } from "./model.js";
import { maskText } from "./redaction.js";

/**
 * Governance for project AI: each AI provider used by a workspace is an
 * agent (so it shows in the inventory, can be suspended and matched by
 * policies), and prompts can be masked before they leave the platform.
 */

const CACHE_TTL_MS = 30_000;
const maskingCache = new Map<string, { value: boolean; at: number }>();
const providerCache = new Map<string, { agent: IAgentDocument; at: number }>();

export const invalidateMaskingSetting = (workspaceId: string): void => {
  maskingCache.delete(workspaceId);
};
export const invalidateProviderAgents = (): void => providerCache.clear();

async function maskingEnabled(workspaceId: string): Promise<boolean> {
  const hit = maskingCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const workspace = await WorkspaceModel.findById(workspaceId)
    .select("settings")
    .lean();
  const value = Boolean(workspace?.settings?.aiDataMasking);
  maskingCache.set(workspaceId, { value, at: Date.now() });
  return value;
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  groq: "Groq",
  ollama: "Ollama",
};

async function providerAgent(
  workspaceId: string,
  userId: string,
  providerId: string,
): Promise<IAgentDocument> {
  const key = `${workspaceId}:${providerId}`;
  const hit = providerCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.agent;
  const fingerprint = `provider:${providerId}`;
  const agent =
    (await AgentModel.findOne({
      workspaceId,
      kind: "ai_provider",
      fingerprint,
    })) ??
    (await AgentModel.findOneAndUpdate(
      { workspaceId, kind: "ai_provider", fingerprint },
      {
        $setOnInsert: {
          workspaceId,
          ownerUserId: userId,
          kind: "ai_provider",
          fingerprint,
          name: PROVIDER_NAMES[providerId] ?? providerId,
          clientName: providerId,
          scopes: ["ai:execute"],
          projectIds: [],
        },
      },
      { upsert: true, new: true },
    ));
  if (agent && !agent.vendorId) {
    const { default: vendorService } = await import("../vendors/service.js");
    await vendorService.linkAgent(agent as IAgentDocument);
  }
  providerCache.set(key, { agent: agent as IAgentDocument, at: Date.now() });
  return agent as IAgentDocument;
}

const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  Types.ObjectId.isValid(value) &&
  /^[a-f0-9]{24}$/i.test(value);

/**
 * Works out whose call this is. Some AI services pass "system" placeholders,
 * so fall back to the request context and the project's workspace.
 */
async function resolveTarget(input: {
  workspaceId: string;
  userId: string;
  projectId?: string | null;
}): Promise<{
  workspaceId: string;
  userId: string;
  projectId: string | null;
} | null> {
  const context = currentRequest();
  const userId = isId(input.userId) ? input.userId : context?.userId;
  const projectId = isId(input.projectId)
    ? input.projectId
    : isId(context?.projectId)
      ? context.projectId
      : null;
  let workspaceId = isId(input.workspaceId) ? input.workspaceId : null;
  try {
    if (!workspaceId && projectId) {
      const project = await ProjectModel.findById(projectId)
        .select("workspaceId")
        .lean();
      workspaceId = project?.workspaceId
        ? project.workspaceId.toString()
        : null;
    }
    if (!workspaceId && userId)
      workspaceId = await agentService.defaultWorkspaceId(userId);
  } catch {
    return null;
  }
  return workspaceId && userId ? { workspaceId, userId, projectId } : null;
}

/**
 * Runs before a prompt is sent to a provider. Throws when the provider is
 * suspended or a policy blocks it; returns the (possibly masked) messages.
 */
export async function governAiCall(input: {
  workspaceId: string;
  userId: string;
  projectId?: string | null;
  providerId: string;
  source: string;
  messages: LlmMessage[];
}): Promise<{
  messages: LlmMessage[];
  agent: IAgentDocument | null;
  masked: boolean;
}> {
  const target = await resolveTarget(input);
  if (!target) return { messages: input.messages, agent: null, masked: false };
  const { workspaceId, userId, projectId } = target;

  let agent: IAgentDocument | null = null;
  try {
    agent = await providerAgent(workspaceId, userId, input.providerId);
  } catch (error) {
    // Governance bookkeeping must not take AI features down.
    logger.warn("Could not register AI provider agent", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (agent) {
    const blocked = agentBlockReason(agent);
    if (blocked) {
      throw new HttpError(
        403,
        `AI provider "${agent.name}" is ${blocked} in this workspace.`,
      );
    }
    const guardInput = {
      agent,
      userId,
      channel: "rest" as const,
      action: `ai:${input.source}`,
      domain: "ai",
      risk: "read" as const,
      input: { source: input.source, provider: input.providerId },
      projectId,
      noHold: true,
    };
    const decision = await authorize(guardInput);
    if (decision.effect !== "allow") {
      const reason =
        decision.effect === "deny" ? decision.reason : "Blocked by policy.";
      activityService.record({
        ...guardInput,
        outcome: "blocked",
        policy: decision.policy,
        statusCode:
          decision.effect === "deny" && decision.retryAfterSec ? 429 : 403,
      });
      throw new HttpError(
        decision.effect === "deny" && decision.retryAfterSec ? 429 : 403,
        reason,
      );
    }
    activityService.record({
      ...guardInput,
      outcome: "allowed",
      advisory: decision.advisory,
    });
  }

  const masked = await maskingEnabled(workspaceId).catch(() => false);
  if (!masked) return { messages: input.messages, agent, masked: false };
  return {
    messages: input.messages.map((message) => ({
      ...message,
      content:
        typeof message.content === "string"
          ? maskText(message.content)
          : message.content,
    })),
    agent,
    masked: true,
  };
}
