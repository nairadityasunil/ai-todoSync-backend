import logger from "../../lib/logger.js";

/**
 * Entry points other modules call when something changed. Loaded lazily so
 * the modules that call these do not depend on the automation engine.
 */

const warn = (error: unknown) =>
  logger.warn("Automation hook failed", {
    message: error instanceof Error ? error.message : String(error),
  });

/** Governance state of a workspace changed: re-check its automation tasks shortly. */
export function automationChanged(
  workspaceId: string | null | undefined,
): void {
  if (!workspaceId) return;
  void import("./automation.service.js")
    .then((m) => m.scheduleWorkspaceSync(String(workspaceId)))
    .catch(warn);
}

/** Same, when only the acting person is known. */
export function automationChangedFor(userId: string | null | undefined): void {
  if (!userId) return;
  void import("../agents/agent.service.js")
    .then(async (m) =>
      automationChanged(await m.default.defaultWorkspaceId(userId)),
    )
    .catch(warn);
}

export function projectCreated(
  project: { id: string; name: string; workspaceId?: string | null },
  userId: string,
): void {
  void import("./automation.service.js")
    .then((m) => m.onProjectCreated(project, userId))
    .catch(warn);
}
