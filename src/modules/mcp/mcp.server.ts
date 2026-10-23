/**
 * MCP Server Bootstrap.
 * Imports all domain tool files (triggering self-registration into the registry),
 * then exports the request handler used by the MCP router.
 */

import toolRegistry from "./registry/tool-registry.js";
import { checkConfirmation } from "./registry/risk-policy.js";
import { validateInput } from "./validation/schema-validator.js";
import { mapDomainError, McpError } from "./errors/mcp-error.js";
import type { McpScope } from "./registry/tool-types.js";
import type { McpToolCallResult } from "./registry/tool-types.js";
import logger from "../../lib/logger.js";
import { runAsAgent } from "../agents/activity.service.js";
import {
  authorize,
  recordDecision,
  type AuthorizeInput,
  type AuthorizeResult,
} from "../agents/guard.js";
import type { IAgentDocument } from "../agents/model.js";
import { snapshotBefore, snapshotCreated } from "../agents/undo.service.js";

// --- Domain tool imports (self-register into toolRegistry at import time) ---
import "./tools/analytics/analytics.tools.js";
import "./tools/task/task.tools.js";
import "./tools/project/project.tools.js";
import "./tools/epic/epic.tools.js";
import "./tools/sla/sla.tools.js";
import "./tools/priority/priority.tools.js";
import "./tools/activity/activity.tools.js";
import "./tools/intelligence/intelligence.tools.js";
import "./tools/ai-capabilities/ai-capabilities.tools.js";
import "./tools/collaboration/collaboration.tools.js";
import "./tools/prompt-library/prompt.tools.js";
import "./tools/workspace/workspace.tools.js";
import "./tools/agents/agents.tools.js";

logger.info(`MCP Server initialized with ${toolRegistry.size()} tools`);

// --- Public API ---

export function listTools(userScopes?: McpScope[]) {
  return toolRegistry.listManifest(userScopes);
}

/**
 * Runs a tool for a user. When the call comes from an agent, the agent
 * governance guard decides first (project allowlist and policies) and the
 * outcome is recorded in the agent's activity log.
 */
export async function callTool(
  toolName: string,
  userId: string,
  userScopes: McpScope[],
  rawInput: Record<string, unknown>,
  agent?: IAgentDocument | null,
): Promise<McpToolCallResult> {
  const entry = toolRegistry.getEntry(toolName);

  if (!entry) {
    throw new McpError(
      "not_found",
      `Tool "${toolName}" not found. Call GET /api/mcp/tools to see available tools.`,
    );
  }

  // Scope check
  if (!userScopes.includes(entry.requiredScope)) {
    throw new McpError(
      "forbidden",
      `Tool "${toolName}" requires scope "${entry.requiredScope}". Your current scopes: ${userScopes.join(", ")}`,
    );
  }

  // Input validation
  const validation = validateInput(entry.inputSchema, rawInput);
  if (!validation.valid) {
    throw new McpError(
      "validation_error",
      `Invalid input for tool "${toolName}"`,
      { errors: validation.errors },
    );
  }

  // Agent governance: project allowlist and workspace policies.
  let guardInput: AuthorizeInput | null = null;
  let decision: AuthorizeResult | null = null;
  if (agent) {
    guardInput = {
      agent,
      userId,
      channel: "mcp",
      action: toolName,
      domain: entry.domain,
      risk: entry.risk,
      input: rawInput,
    };
    decision = await authorize(guardInput);
    if (decision.effect === "deny") {
      recordDecision(guardInput, decision, { statusCode: 403 });
      throw new McpError("forbidden", decision.reason, {
        policy: decision.policy?.name ?? null,
      });
    }
    if (decision.effect === "require_approval") {
      recordDecision(guardInput, decision, { statusCode: 202 });
      throw new McpError(
        "approval_required",
        `"${toolName}" needs approval under policy "${decision.policy.name}". A workspace or project admin has been asked to review it; call agents:approval_status with the approvalId to get the outcome.`,
        {
          approvalId: decision.approval._id.toString(),
          policy: decision.policy.name,
          expiresAt: decision.approval.expiresAt,
        },
      );
    }
  }

  // Confirmation check (for destructive / sensitive_write tools)
  const confirmationResult = await checkConfirmation(entry, userId, rawInput);
  if (confirmationResult) {
    throw new McpError("confirmation_required", confirmationResult.summary, {
      confirmationToken: confirmationResult.confirmationToken,
      tool: toolName,
    });
  }

  // Execute
  const before =
    agent && entry.risk !== "read"
      ? await snapshotBefore(toolName, rawInput)
      : null;
  const started = Date.now();
  try {
    logger.info(`MCP tool call: ${toolName}`, {
      userId,
      agentId: agent?._id.toString(),
      tool: toolName,
      domain: entry.domain,
      risk: entry.risk,
    });

    const data = agent
      ? await runAsAgent(agent, () => entry.handler(userId, rawInput))
      : await entry.handler(userId, rawInput);

    if (guardInput && decision) {
      recordDecision(guardInput, decision, {
        statusCode: 200,
        durationMs: Date.now() - started,
        undo: before ?? snapshotCreated(toolName, data),
      });
    }

    return {
      tool: toolName,
      data,
      risk: entry.risk,
      domain: entry.domain,
    };
  } catch (error) {
    const mcpError = mapDomainError(error);
    if (guardInput && decision) {
      recordDecision(guardInput, decision, {
        statusCode: mcpError.httpStatus,
        error: mcpError.message,
        durationMs: Date.now() - started,
      });
    }
    logger.error(`MCP tool "${toolName}" failed: ${mcpError.message}`, {
      userId,
      tool: toolName,
      code: mcpError.code,
    });
    throw mcpError;
  }
}
