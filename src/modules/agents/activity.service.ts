import { AsyncLocalStorage } from "node:async_hooks";

import logger from "../../lib/logger.js";
import type { RiskLevel } from "../mcp/registry/tool-types.js";
import agentService from "./agent.service.js";
import {
  AgentActivityModel,
  AgentAlertModel,
  type AgentActivityOutcome,
  type AgentUndoSnapshot,
  type IAgentDocument,
} from "./model.js";
import type { PolicyLike } from "./policy-engine.js";
import { redactInput } from "./redaction.js";
import webhookService from "./webhooks.service.js";

/** The agent behind the current request, for code deep in domain services. */
export interface AgentActor {
  id: string;
  name: string;
  kind: string;
}

const actorStore = new AsyncLocalStorage<AgentActor>();

export const runAsAgent = <T>(agent: IAgentDocument, fn: () => T): T =>
  actorStore.run(
    { id: agent._id.toString(), name: agent.name, kind: agent.kind },
    fn,
  );

export const currentAgent = (): AgentActor | undefined => actorStore.getStore();

export interface RecordInput {
  agent: IAgentDocument;
  userId: string;
  channel: "mcp" | "rest";
  action: string;
  domain: string;
  risk: RiskLevel;
  input: Record<string, unknown>;
  projectId?: string | null;
  outcome: AgentActivityOutcome;
  policy?: PolicyLike | null;
  advisory?: PolicyLike[];
  approvalId?: string | null;
  statusCode?: number | null;
  error?: string | null;
  durationMs?: number | null;
  undo?: AgentUndoSnapshot | null;
}

const HOUR = 3600 * 1000;

class AgentActivityService {
  /** Fire-and-forget: logging never slows down or breaks the agent's call. */
  public record(entry: RecordInput): void {
    void this.write(entry);
  }

  public async write(entry: RecordInput): Promise<void> {
    const agentId = entry.agent._id.toString();
    agentService.touch(agentId);
    try {
      await AgentActivityModel.create({
        agentId,
        workspaceId: entry.agent.workspaceId ?? null,
        projectId: entry.projectId ?? null,
        userId: entry.userId,
        channel: entry.channel,
        action: entry.action,
        domain: entry.domain,
        risk: entry.risk,
        input: redactInput(entry.input),
        outcome: entry.outcome,
        statusCode: entry.statusCode ?? null,
        policyId: entry.policy?.id ?? null,
        policyName: entry.policy?.name ?? null,
        advisoryPolicies: (entry.advisory ?? []).map((policy) => policy.name),
        approvalId: entry.approvalId ?? null,
        error: entry.error ? entry.error.slice(0, 500) : null,
        durationMs: entry.durationMs ?? null,
        // Only successful changes can be undone.
        undo: entry.outcome === "allowed" && entry.undo ? entry.undo : null,
      });
      if (entry.outcome === "blocked") {
        webhookService.emit({
          type: "activity.blocked",
          workspaceId: entry.agent.workspaceId?.toString() ?? null,
          summary: `${entry.agent.name} was blocked from ${entry.action}${entry.policy ? ` by policy "${entry.policy.name}"` : ""}`,
          data: {
            agentId,
            agentName: entry.agent.name,
            agentKind: entry.agent.kind,
            action: entry.action,
            risk: entry.risk,
            channel: entry.channel,
            policy: entry.policy?.name ?? null,
            statusCode: entry.statusCode ?? null,
            projectId: entry.projectId ?? null,
          },
        });
        const bucket = Math.floor(Date.now() / HOUR);
        await raiseAlert({
          workspaceId: entry.agent.workspaceId?.toString() ?? null,
          agentId,
          type: "policy_block",
          severity: "info",
          title: `${entry.agent.name} was blocked`,
          detail: entry.policy
            ? `"${entry.action}" was blocked by policy "${entry.policy.name}".`
            : `"${entry.action}" was outside the agent's allowed projects.`,
          dedupeKey: `policy_block:${agentId}:${entry.action}:${bucket}`,
        });
      }
    } catch (error) {
      logger.warn("Could not record agent activity", {
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Inserts an alert once per dedupe key. Returns true when it was new. */
export async function raiseAlert(alert: {
  workspaceId: string | null;
  agentId: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  dedupeKey: string;
}): Promise<boolean> {
  const result = await AgentAlertModel.updateOne(
    { dedupeKey: alert.dedupeKey },
    { $setOnInsert: { ...alert, createdAt: new Date() } },
    { upsert: true },
  );
  const raised = result.upsertedCount > 0;
  if (raised) {
    webhookService.emit({
      type: "alert.raised",
      workspaceId: alert.workspaceId,
      severity: alert.severity,
      summary: `${alert.title}. ${alert.detail}`,
      data: {
        agentId: alert.agentId,
        alertType: alert.type,
        title: alert.title,
        detail: alert.detail,
      },
    });
  }
  return raised;
}

export default new AgentActivityService();
