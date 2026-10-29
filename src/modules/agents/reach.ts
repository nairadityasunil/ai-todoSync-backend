import { Types } from "mongoose";

import ProjectModel from "../project/models/project.model.js";
import ProjectMemberModel from "../project/models/project-member.model.js";
import toolRegistry from "../mcp/registry/tool-registry.js";
import type { McpScope, RiskLevel } from "../mcp/registry/tool-types.js";
import { AgentActivityModel, type IAgentDocument } from "./model.js";
import { scopeFor } from "./rest-guard.js";

/**
 * Reach map: what an agent can reach against what it has used, and the
 * narrower access that would still cover its use. Only changes and blocked
 * calls are logged (reads are not), so read scopes are never suggested for
 * removal and project limits are suggested only from projects it changed.
 */

const DAY = 86400000;
export const REACH_WINDOW_DAYS = 90;
/** Younger agents have not shown enough of their use to judge it. */
export const REACH_MIN_AGE_DAYS = 14;

export interface ReachInput {
  scopes: string[];
  /** Empty means every project its owner can reach. */
  projectIds: string[];
  usedScopes: Map<string, number>;
  /** Projects changed in the window (null: outside any project). */
  usedProjects: Map<string | null, number>;
}

export interface ReachSuggestion {
  removableScopes: string[];
  /** Narrower access, or null when it would change nothing. */
  suggestion: { scopes: string[]; projectIds: string[] } | null;
}

export function suggestReach(input: ReachInput): ReachSuggestion {
  const removableScopes = input.scopes.filter(
    (scope) => !scope.endsWith(":read") && !input.usedScopes.has(scope),
  );
  const used = [...input.usedProjects.keys()].filter((id): id is string =>
    Boolean(id),
  );
  // Calls outside any project would be refused under a project limit.
  const outsideProjects = input.usedProjects.has(null);
  let projectIds = input.projectIds;
  if (used.length > 0 && !outsideProjects) {
    projectIds =
      input.projectIds.length === 0
        ? used
        : input.projectIds.filter((id) => used.includes(id));
  }
  const scopes = input.scopes.filter((s) => !removableScopes.includes(s));
  const narrower =
    removableScopes.length > 0 ||
    projectIds.length !== input.projectIds.length ||
    (input.projectIds.length === 0 && projectIds.length > 0);
  return {
    removableScopes,
    suggestion: narrower
      ? { scopes, projectIds: [...projectIds].sort() }
      : null,
  };
}

const scopeOfActivity = (row: {
  channel: string;
  action: string;
  domain: string;
  risk: RiskLevel;
}): McpScope =>
  (row.channel === "mcp"
    ? toolRegistry.getEntry(row.action)?.requiredScope
    : undefined) ?? scopeFor(row.domain, row.risk);

export async function reachReport(agent: IAgentDocument, now = new Date()) {
  const created = agent.createdAt ?? now;
  const since = new Date(
    Math.max(created.getTime(), now.getTime() - REACH_WINDOW_DAYS * DAY),
  );
  const tooNew = now.getTime() - created.getTime() < REACH_MIN_AGE_DAYS * DAY;
  const match = { agentId: agent._id, createdAt: { $gte: since } };

  const [actions, projects] = await Promise.all([
    AgentActivityModel.aggregate<{
      _id: { channel: string; action: string; domain: string; risk: RiskLevel };
      calls: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: {
            channel: "$channel",
            action: "$action",
            domain: "$domain",
            risk: "$risk",
          },
          calls: { $sum: 1 },
        },
      },
    ]),
    AgentActivityModel.aggregate<{ _id: unknown; calls: number }>([
      { $match: { ...match, risk: { $ne: "read" } } },
      { $group: { _id: "$projectId", calls: { $sum: 1 } } },
    ]),
  ]);

  const usedScopes = new Map<string, number>();
  for (const row of actions) {
    const scope = scopeOfActivity(row._id);
    usedScopes.set(scope, (usedScopes.get(scope) ?? 0) + row.calls);
  }
  const usedProjects = new Map<string | null, number>();
  for (const row of projects)
    usedProjects.set(row._id ? String(row._id) : null, row.calls);

  const granted = (agent.projectIds ?? []).map(String);
  const { removableScopes, suggestion } = suggestReach({
    scopes: agent.scopes,
    projectIds: granted,
    usedScopes,
    usedProjects,
  });

  const ids = [...new Set([...granted, ...usedProjects.keys()])].filter(
    (id): id is string => Boolean(id) && Types.ObjectId.isValid(id as string),
  );
  const [named, ownerProjects] = await Promise.all([
    ProjectModel.find({ _id: { $in: ids } })
      .select("name")
      .lean(),
    granted.length === 0 && agent.kind !== "ai_provider"
      ? ProjectMemberModel.countDocuments({ userId: agent.ownerUserId })
      : Promise.resolve(null),
  ]);
  const nameOf = new Map(named.map((p) => [p._id.toString(), p.name]));

  return {
    windowDays: REACH_WINDOW_DAYS,
    since: since.toISOString(),
    tooNew,
    scopes: agent.scopes.map((scope) => ({
      scope,
      used: usedScopes.get(scope) ?? 0,
      removable: !tooNew && removableScopes.includes(scope),
      logged: !scope.endsWith(":read"),
    })),
    projects: {
      all: granted.length === 0,
      ownerProjectCount: ownerProjects,
      granted: granted.map((id) => ({
        id,
        name: nameOf.get(id) ?? "Removed project",
        used: usedProjects.get(id) ?? 0,
      })),
      used: [...usedProjects.entries()]
        .map(([id, calls]) => ({
          id,
          name: id ? (nameOf.get(id) ?? "Removed project") : "Outside projects",
          calls,
        }))
        .sort((a, b) => b.calls - a.calls),
    },
    suggestion: tooNew ? null : suggestion,
  };
}
