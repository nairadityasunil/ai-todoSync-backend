import type { IPolicyMatch, PolicyEffect, PolicyMode } from "./model.js";

/** Ready-made policies offered in the policy editor. */
export const POLICY_TEMPLATES: Array<{
  id: string;
  name: string;
  description: string;
  effect: PolicyEffect;
  mode: PolicyMode;
  priority: number;
  match: IPolicyMatch;
}> = [
  {
    id: "approve-destructive",
    name: "Approve destructive actions",
    description:
      "Any agent that deletes or does something irreversible waits for a workspace or project admin.",
    effect: "require_approval",
    mode: "enforce",
    priority: 200,
    match: { minRisk: "destructive" },
  },
  {
    id: "read-only-chatgpt",
    name: "ChatGPT is read-only",
    description:
      "ChatGPT Actions can read tasks and projects but cannot change anything.",
    effect: "deny",
    mode: "enforce",
    priority: 150,
    match: { agentKinds: ["chatgpt"], minRisk: "write" },
  },
  {
    id: "read-only-unregistered",
    name: "Unregistered agents are read-only",
    description:
      "Scripts and automated browsers using a person's login can read but not change anything until they get an agent key.",
    effect: "deny",
    mode: "enforce",
    priority: 160,
    match: { agentKinds: ["detected"], minRisk: "write" },
  },
  {
    id: "no-after-hours-changes",
    name: "No changes outside business hours",
    description:
      "Agents cannot change data outside 09:00-18:00, Monday to Friday (UTC).",
    effect: "deny",
    mode: "advisory",
    priority: 120,
    match: {
      minRisk: "write",
      timeWindow: {
        days: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 18,
        timezone: "UTC",
        outside: true,
      },
    },
  },
  {
    id: "approve-sensitive",
    name: "Approve member and permission changes",
    description:
      "Adding members or changing roles through an agent needs approval.",
    effect: "require_approval",
    mode: "enforce",
    priority: 180,
    match: { minRisk: "sensitive_write" },
  },
  {
    id: "block-project-delete",
    name: "Agents never delete projects",
    description: "Project deletion is reserved for people.",
    effect: "deny",
    mode: "enforce",
    priority: 300,
    match: { tools: ["project:delete"] },
  },
];
