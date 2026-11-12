/** One row of the unified activity timeline. */
export interface TimelineItem {
  id: string;
  kind: "work" | "agent" | "approval" | "event" | "detection" | "incident" | "system";
  at: string;
  title: string;
  detail?: string;
  actor: { type: "person" | "agent" | "end_user"; id?: string; name: string };
  projectId?: string | null;
  /** Portal path that opens the related task, agent, approval or event view. */
  link?: string;
  /** Who decided an agent action: a policy, the system (default rule, DLP, threat, safety net) or a person. */
  decidedBy?: "policy" | "system" | "person" | null;
  outcome?: string | null;
  tier?: string | null;
  severity?: string | null;
}


/** Newest first, ties broken by id so pages are stable. */
export function mergeTimeline(
  groups: TimelineItem[][],
  limit: number,
): TimelineItem[] {
  return groups
    .flat()
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    .slice(0, limit);
}

