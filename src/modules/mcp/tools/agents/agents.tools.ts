/**
 * Agent governance MCP tools: lets an agent follow up on actions that were
 * held for human approval.
 */

import toolRegistry from "../../registry/tool-registry.js";
import approvalService from "../../../agents/approval.service.js";

toolRegistry.register({
  name: "agents:approval_status",
  description:
    "Check an action that was held for approval. Returns pending, approved, rejected, expired, executed or failed, plus the result once it has run.",
  domain: "agents",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["approvalId"],
    properties: {
      approvalId: { type: "string" },
    },
  },
  requiredScope: "work:read",
  risk: "read",
  handler: async (userId, input) => {
    const { approvalId } = input as { approvalId: string };
    const approval = await approvalService.getForUser(approvalId, userId);
    return {
      approvalId: approval._id.toString(),
      action: approval.action,
      status: approval.status,
      note: approval.note ?? null,
      decidedAt: approval.decidedAt ?? null,
      expiresAt: approval.expiresAt,
      result: approval.status === "executed" ? approval.result : undefined,
      error: approval.error ?? null,
    };
  },
});
