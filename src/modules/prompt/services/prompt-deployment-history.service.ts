import type { Types } from "mongoose";

import logger from "../../../lib/logger.js";
import UserModel from "../../auth/models/user.model.js";
import PromptDeploymentEventModel, {
  PRODUCTION_CHANGES,
  type DeploymentAction,
} from "../models/prompt-deployment-event.model.js";

/** Writes and reads a prompt's deployment history. Recording never blocks or fails a deployment. */
export class PromptDeploymentHistoryService {
  public async record(event: {
    workspaceId: unknown;
    promptId: unknown;
    action: DeploymentAction;
    version: number;
    previousVersion?: number | null;
    reason?: string;
    by?: unknown;
  }): Promise<void> {
    try {
      await PromptDeploymentEventModel.create({
        workspaceId: event.workspaceId as never,
        promptId: event.promptId as never,
        action: event.action,
        version: event.version,
        previousVersion: event.previousVersion ?? null,
        reason: (event.reason ?? "").slice(0, 500),
        by: (event.by as never) ?? null,
      });
    } catch (err) {
      logger.warn("Could not record a prompt deployment event", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async list(promptId: Types.ObjectId | string, limit = 50) {
    const rows = await PromptDeploymentEventModel.find({ promptId })
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Math.max(1, limit)))
      .lean();
    const users = await UserModel.find({
      _id: { $in: rows.map((r) => r.by).filter(Boolean) },
    })
      .select("name email")
      .lean();
    const names = new Map(
      users.map((u) => [String(u._id), u.name || u.email || "Someone"]),
    );
    return rows.map((r) => ({
      id: String(r._id),
      action: r.action,
      version: r.version,
      previousVersion: r.previousVersion ?? null,
      reason: r.reason,
      by: r.by ? (names.get(String(r.by)) ?? "Someone") : "Pristine",
      at: r.createdAt,
    }));
  }

  /** The production version before the current one, from the history. */
  public async previousProductionVersion(
    promptId: Types.ObjectId | string,
    current: number,
  ): Promise<number | null> {
    const rows = await PromptDeploymentEventModel.find({
      promptId,
      action: { $in: PRODUCTION_CHANGES },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    for (const row of rows) {
      if (row.version !== current) return row.version;
      if (row.previousVersion != null && row.previousVersion !== current)
        return row.previousVersion;
    }
    return null;
  }
}

export default new PromptDeploymentHistoryService();
