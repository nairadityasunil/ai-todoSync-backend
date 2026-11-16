import { raiseAlert } from "../agents/activity.service.js";
import agentService from "../agents/agent.service.js";
import { consume } from "../agents/rate-limit.js";
import SdkIntegrationModel from "../sdk-integrations/model.js";

/**
 * An app's SDK key sits in its web pages, so anyone can copy it. These limits
 * cap what one key can push, whoever holds it: a flood is refused with 429 and
 * the integration's owner gets an alert.
 */
const fromEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const INGEST_LIMITS = {
  /** Log lines per minute, per integration. */
  logs: () => fromEnv("SDK_INGEST_LOGS_PER_MINUTE", 3000),
  /** AI interactions per minute, per integration. */
  ai: () => fromEnv("SDK_INGEST_AI_PER_MINUTE", 600),
};

export type IngestKind = keyof typeof INGEST_LIMITS;

/** Counts a batch against the integration's limit. Returns null when it fits, else seconds to wait. */
export async function checkIngestLimit(
  kind: IngestKind,
  integrationId: string,
  cost: number,
  now = Date.now(),
): Promise<number | null> {
  const decision = await consume(
    `sdk-ingest:${kind}:${integrationId}`,
    INGEST_LIMITS[kind](),
    now,
    Math.max(1, cost),
  );
  if (decision.allowed) return null;
  // One alert per integration per hour, so a flood does not become a flood of alerts.
  const hour = Math.floor(now / 3_600_000);
  void (async () => {
    try {
      const integration = await SdkIntegrationModel.findById(integrationId)
        .select("tenantId name")
        .lean();
      if (!integration) return;
      const workspaceId = await agentService.defaultWorkspaceId(
        String(integration.tenantId),
      );
      await raiseAlert({
        workspaceId,
        type: "sdk_ingest_limit",
        severity: "warning",
        title: `${integration.name} is sending more ${kind === "ai" ? "AI interactions" : "logs"} than allowed`,
        detail: `The app's SDK key went over ${INGEST_LIMITS[kind]()} ${kind === "ai" ? "interactions" : "logs"} a minute, so the extra ones were refused. If this is not your traffic, rotate the key; anyone with a copy of it can send data.`,
        dedupeKey: `sdk_ingest_limit:${kind}:${integrationId}:${hour}`,
      });
    } catch {
      /* the limit itself already applied */
    }
  })();
  return decision.retryAfterSec;
}
