/**
 * Credential hygiene rules for agents: who has lost their owner, who has
 * gone unused, and whose access is due for review. Pure, so they can be
 * unit tested; the nightly job in governance.service applies them.
 */

const DAY = 86400000;

/** Owners confirm their agents are still needed this often. */
export const ACCESS_REVIEW_DAYS = 90;
export const DEFAULT_INACTIVE_AGENT_DAYS = 60;
/** Choices offered for suspending unused agents; 0 turns it off. */
export const INACTIVE_AGENT_DAY_OPTIONS = [0, 30, 60, 90] as const;

export interface HygieneSubject {
  kind: string;
  status: string;
  createdAt?: Date | null;
  lastSeenAt?: Date | null;
  reviewedAt?: Date | null;
}

export type HygieneAction = "orphaned" | "inactive";

/**
 * What the nightly job should do with an active agent. An agent whose owner
 * left is suspended whatever else is true; an unused one only when the
 * workspace sets a limit. AI providers belong to the workspace, not a person.
 */
export function hygieneAction(
  agent: HygieneSubject,
  input: { ownerIsMember: boolean; inactiveDays: number; now?: Date },
): HygieneAction | null {
  if (agent.status !== "active" || agent.kind === "ai_provider") return null;
  const now = (input.now ?? new Date()).getTime();
  // An admin who resumed or confirmed an orphaned agent has decided to keep it.
  const recentlyReviewed =
    agent.reviewedAt &&
    now - agent.reviewedAt.getTime() < ACCESS_REVIEW_DAYS * DAY;
  if (!input.ownerIsMember && !recentlyReviewed) return "orphaned";
  if (input.inactiveDays > 0) {
    // Confirming or resuming an agent restarts its clock like a call does.
    const lastActive = Math.max(
      ...[agent.lastSeenAt, agent.reviewedAt, agent.createdAt].map(
        (date) => date?.getTime() ?? 0,
      ),
    );
    if (lastActive > 0 && now - lastActive > input.inactiveDays * DAY)
      return "inactive";
  }
  return null;
}

/** When the agent's access next needs its owner to confirm it. */
export function reviewDueAt(agent: HygieneSubject): Date | null {
  const since = agent.reviewedAt ?? agent.createdAt;
  return since ? new Date(since.getTime() + ACCESS_REVIEW_DAYS * DAY) : null;
}

export function isReviewDue(agent: HygieneSubject, now = new Date()): boolean {
  if (agent.status === "revoked") return false;
  const due = reviewDueAt(agent);
  return Boolean(due && due.getTime() <= now.getTime());
}

export const normalizeInactiveDays = (value: unknown): number => {
  const n = Number(value);
  return (INACTIVE_AGENT_DAY_OPTIONS as readonly number[]).includes(n)
    ? n
    : DEFAULT_INACTIVE_AGENT_DAYS;
};
