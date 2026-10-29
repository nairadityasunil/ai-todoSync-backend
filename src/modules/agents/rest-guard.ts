import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";

import type { McpScope, RiskLevel } from "../mcp/registry/tool-types.js";
import { runAsAgent } from "./activity.service.js";
import {
  authorize,
  recordDecision,
  resolveProjectId,
  type AuthorizeInput,
} from "./guard.js";
import type { IAgentDocument } from "./model.js";
import { snapshotBefore } from "./undo.service.js";

/**
 * Applies agent governance to REST calls made with an agent credential
 * (API keys, ChatGPT Actions, companion devices). Calls are named like MCP
 * tools ("task:delete", "epic:create") so one policy covers both channels.
 */

export interface RestAction {
  action: string;
  domain: string;
  risk: RiskLevel;
  scope: McpScope;
  /** Agents may never call this endpoint (credential and agent management). */
  forbidden: boolean;
  refs: { projectId?: string; taskId?: string; epicId?: string };
}

const isId = (segment: string): boolean =>
  Types.ObjectId.isValid(segment) && /^[a-f0-9]{24}$/i.test(segment);

const singular = (word: string): string => {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
};

const VERBS: Record<string, string> = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

/** Endpoints only a person may use. GET /api/agents/approvals/:id stays open so agents can poll. */
const isForbiddenForAgents = (
  domain: string,
  segments: string[],
  method: string,
): boolean => {
  if (domain === "agent")
    return !(method === "GET" && segments[0] === "approvals");
  // Vendor approval is for people: an agent must not approve its own vendor.
  if (domain === "vendor") return true;
  if (method === "GET" || method === "HEAD") return false;
  // Anything that signs in, pairs a device or mints a key: an agent must not
  // be able to turn itself into a broader credential.
  if (["auth", "companion", "key", "user"].includes(domain)) return true;
  if (domain === "sdk_integration") {
    return (
      segments.length === 0 ||
      segments.some((segment) => /regenerate|key|secret/.test(segment))
    );
  }
  return false;
};

/** The scope a call in this domain at this risk needs (reads need work:read). */
export function scopeFor(domain: string, risk: RiskLevel): McpScope {
  if (risk === "read") return "work:read";
  if (domain === "workspace") return "workspace:admin";
  if (["ai", "ai_planning", "ai_planner"].includes(domain)) return "ai:execute";
  if (domain === "prompt" || domain === "prompt_library") return "prompt:write";
  if (["chat", "comment", "note", "document"].includes(domain))
    return "collaboration:write";
  return "work:write";
}

export function describeRestCall(method: string, path: string): RestAction {
  const segments = path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      decodeURIComponent(segment)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, ""),
    );
  if (segments[0] === "api") segments.shift();
  const domain = singular(segments[0] || "api").replace(/-/g, "_");
  const rest = segments.slice(1);
  const words = rest.filter((segment) => !isId(segment));
  const lastWord = words[words.length - 1];
  const endsWithId = rest.length > 0 && isId(rest[rest.length - 1]);

  const isRead = method === "GET" || method === "HEAD";
  const verb = isRead
    ? endsWithId
      ? "get"
      : "list"
    : (VERBS[method] ?? method.toLowerCase());
  let action: string;
  if (!lastWord) {
    action = `${domain}:${verb}`;
  } else if (singular(lastWord) !== lastWord) {
    // Nested collection: POST /projects/:id/epics -> epic:create
    action = `${singular(lastWord).replace(/-/g, "_")}:${verb}`;
  } else {
    // Command or view: POST /tasks/:id/complete -> task:complete
    action = `${domain}:${lastWord.replace(/-/g, "_")}`;
  }

  let risk: RiskLevel = "read";
  if (method !== "GET" && method !== "HEAD") {
    risk = method === "DELETE" ? "destructive" : "write";
    if (
      ["workspace", "invitation"].includes(domain) ||
      /member|invite|role|permission/.test(path)
    ) {
      risk = method === "DELETE" ? "destructive" : "sensitive_write";
    }
    if (domain === "auth" || domain === "agent") risk = "security_critical";
  }

  const scope = scopeFor(domain, risk);

  const refs: RestAction["refs"] = {};
  rest.forEach((segment, index) => {
    if (!isId(segment)) return;
    const owner = index === 0 ? segments[0] : rest[index - 1];
    if (owner === "projects") refs.projectId = segment;
    if (owner === "tasks") refs.taskId = segment;
    if (owner === "epics") refs.epicId = segment;
  });

  return {
    action,
    domain,
    risk,
    scope,
    forbidden: isForbiddenForAgents(domain, rest, method),
    refs,
  };
}

const firstString = (...values: unknown[]): string | undefined =>
  values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

/** Runs inside authMiddleware once the request is known to come from an agent. */
export async function guardAgentRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  agent: IAgentDocument,
  userId: string,
): Promise<void> {
  const method = req.method.toUpperCase();
  const path = req.originalUrl;
  const call = describeRestCall(method, path);

  if (call.forbidden) {
    res.status(403).json({
      error: "agent_forbidden",
      message: "Agents cannot manage credentials, sign-in or agent governance.",
    });
    return;
  }
  if (!agent.scopes.includes(call.scope)) {
    res.status(403).json({
      error: "agent_scope",
      message: `This agent lacks the "${call.scope}" scope needed for ${call.action}.`,
    });
    return;
  }

  const body = (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  // Records named in the path are the ones being changed; body and query ids
  // only count when the path names none.
  const pathNamesRecord = Boolean(call.refs.taskId || call.refs.epicId);
  const resolution = await resolveProjectId({
    projectId: firstString(
      call.refs.projectId,
      body.projectId,
      query.projectId,
    ),
    taskId: pathNamesRecord
      ? call.refs.taskId
      : firstString(body.taskId, query.taskId),
    epicId: pathNamesRecord
      ? call.refs.epicId
      : firstString(body.epicId, query.epicId),
  });
  const projectId = resolution.projectId;

  const guardInput: AuthorizeInput = {
    agent,
    userId,
    channel: "rest",
    action: call.action,
    domain: call.domain,
    risk: call.risk,
    input: body,
    projectId,
    resolvedProjects: resolution,
    request: { method, path },
  };
  const decision = await authorize(guardInput);

  if (decision.effect === "deny" && decision.retryAfterSec) {
    recordDecision(guardInput, decision, { statusCode: 429 });
    res.setHeader("Retry-After", String(decision.retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: decision.reason,
      retryAfterSec: decision.retryAfterSec,
    });
    return;
  }
  if (decision.effect === "deny") {
    recordDecision(guardInput, decision, { statusCode: 403 });
    res.status(403).json({
      error: "agent_blocked",
      message: decision.reason,
      policy: decision.policy?.name ?? null,
    });
    return;
  }
  if (decision.effect === "require_approval") {
    recordDecision(guardInput, decision, { statusCode: 202 });
    const approvalId = decision.approval._id.toString();
    res.status(202).json({
      error: "approval_required",
      message: `${call.action} needs approval under policy "${decision.policy.name}". It runs automatically once a workspace or project admin approves it.`,
      approvalId,
      statusUrl: `/api/agents/approvals/${approvalId}`,
      expiresAt: decision.approval.expiresAt,
    });
    return;
  }

  // Reads are frequent (sync polling), so only changes and blocks are logged.
  if (call.risk !== "read" || decision.advisory.length > 0) {
    const undo =
      call.risk !== "read"
        ? // Only the record the route itself targets: ids in the body may name
          // records the call never touches.
          await snapshotBefore(call.action, {
            taskId: call.refs.taskId,
            epicId: call.refs.epicId,
          })
        : null;
    const started = Date.now();
    res.on("finish", () => {
      recordDecision(guardInput, decision, {
        statusCode: res.statusCode,
        error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
        durationMs: Date.now() - started,
        undo,
      });
    });
  }
  runAsAgent(agent, () => next());
}
