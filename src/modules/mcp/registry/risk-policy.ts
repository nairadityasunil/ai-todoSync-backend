import { createHash, randomBytes } from "crypto";

import { McpConfirmationModel } from "../../agents/model.js";
import type { ToolEntry } from "./tool-types.js";

interface PendingConfirmation {
  toolName: string;
  userId: string;
  expiresAt: Date;
}

/** Where confirmation tokens live. Persisted by default so they survive restarts and work across instances. */
export interface ConfirmationStore {
  put(tokenHash: string, pending: PendingConfirmation): Promise<void>;
  /** Removes and returns the token's record, if any. */
  take(tokenHash: string): Promise<PendingConfirmation | null>;
}

const mongoStore: ConfirmationStore = {
  async put(tokenHash, pending) {
    await McpConfirmationModel.create({ tokenHash, ...pending });
  },
  async take(tokenHash) {
    const doc = await McpConfirmationModel.findOneAndDelete({
      tokenHash,
    }).lean();
    return doc
      ? { toolName: doc.toolName, userId: doc.userId, expiresAt: doc.expiresAt }
      : null;
  },
};

export const createMemoryConfirmationStore = (): ConfirmationStore => {
  const tokens = new Map<string, PendingConfirmation>();
  return {
    async put(tokenHash, pending) {
      tokens.set(tokenHash, pending);
    },
    async take(tokenHash) {
      const pending = tokens.get(tokenHash) ?? null;
      tokens.delete(tokenHash);
      return pending;
    },
  };
};

let store: ConfirmationStore = mongoStore;

export const setConfirmationStore = (next: ConfirmationStore): void => {
  store = next;
};

const TOKEN_TTL_MS = 60_000; // 60 seconds

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Check if a tool call needs confirmation and validate / issue tokens.
 * Returns null if the call may proceed, or a confirmation-required payload.
 */
export async function checkConfirmation(
  entry: ToolEntry,
  userId: string,
  input: Record<string, unknown>,
): Promise<{
  confirmationRequired: true;
  confirmationToken: string;
  summary: string;
} | null> {
  if (!entry.requiresConfirmation) {
    return null;
  }

  const providedToken = input._confirmationToken;

  if (typeof providedToken === "string" && providedToken.length > 0) {
    const pending = await store.take(hashToken(providedToken));
    if (
      pending &&
      pending.toolName === entry.name &&
      pending.userId === userId &&
      Date.now() < pending.expiresAt.getTime()
    ) {
      return null; // Confirmed — proceed
    }
    // Invalid or expired token — issue a new one
  }

  const token = randomBytes(24).toString("hex");
  await store.put(hashToken(token), {
    toolName: entry.name,
    userId,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  return {
    confirmationRequired: true,
    confirmationToken: token,
    summary: buildSummary(entry, input),
  };
}

function buildSummary(
  entry: ToolEntry,
  input: Record<string, unknown>,
): string {
  const relevant = { ...input };
  delete relevant._confirmationToken;
  const inputPreview = JSON.stringify(relevant).slice(0, 200);
  return `Tool "${entry.name}" (risk: ${entry.risk}) requires confirmation before execution. Input: ${inputPreview}. Include _confirmationToken in next call to proceed (valid 60s).`;
}
