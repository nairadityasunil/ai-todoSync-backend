import { createHmac, randomBytes, randomUUID } from "node:crypto";

import logger from "../../lib/logger.js";
import { decrypt } from "../../utils/encryption.js";
import { safePost, type SafePostResult } from "../../utils/safe-http.js";
import {
  AgentWebhookModel,
  type IAgentWebhook,
  type IAgentWebhookDocument,
  type WebhookEvent,
} from "./model.js";

/**
 * Sends governance events (alerts, approvals, blocked actions) to each
 * workspace's webhooks: signed JSON for SIEM tools and other systems, or
 * Slack messages. Delivery is best effort with retries, in this process;
 * an event is never allowed to slow down or fail the action behind it.
 */

export type Severity = "info" | "warning" | "critical";

export interface GovernanceEvent {
  type: WebhookEvent;
  workspaceId: string | null;
  /** One line a person can read, e.g. in Slack. */
  summary: string;
  severity?: Severity;
  data: Record<string, unknown>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};
const RETRY_DELAYS_MS = [1000, 5000];
/** Webhooks failing this many deliveries in a row are switched off. */
export const MAX_CONSECUTIVE_FAILURES = 10;
const CACHE_TTL_MS = 30_000;

/** Local development only: lets webhooks reach http:// and local addresses. */
const allowPrivate = () =>
  process.env.AGENT_WEBHOOKS_ALLOW_PRIVATE === "true" &&
  process.env.NODE_ENV !== "production";

export const newWebhookSecret = (): string =>
  `whsec_${randomBytes(24).toString("base64url")}`;

/** Whether a webhook wants this event. */
export function wants(
  webhook: Pick<IAgentWebhook, "events" | "minSeverity" | "enabled">,
  event: Pick<GovernanceEvent, "type" | "severity">,
): boolean {
  if (!webhook.enabled || !webhook.events.includes(event.type)) return false;
  if (event.type !== "alert.raised") return true;
  return (
    SEVERITY_RANK[event.severity ?? "info"] >=
    SEVERITY_RANK[webhook.minSeverity]
  );
}

/** The request body and headers for one delivery. */
export function buildDelivery(
  webhook: Pick<IAgentWebhook, "format">,
  secret: string,
  event: GovernanceEvent,
  now = new Date(),
): { body: string; headers: Record<string, string> } {
  const id = randomUUID();
  if (webhook.format === "slack") {
    const label = event.severity
      ? `[${event.severity[0].toUpperCase()}${event.severity.slice(1)}] `
      : "";
    return {
      body: JSON.stringify({
        text: `${label}${event.summary}`,
        // Slack renders `text` in notifications and these blocks in the channel.
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${label}${event.summary}*` },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Agent Governance · ${event.type} · ${now.toISOString()}`,
              },
            ],
          },
        ],
      }),
      headers: {},
    };
  }
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const body = JSON.stringify({
    id,
    type: event.type,
    occurredAt: now.toISOString(),
    workspaceId: event.workspaceId,
    severity: event.severity ?? null,
    summary: event.summary,
    data: event.data,
  });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return {
    body,
    headers: {
      "x-pristine-event": event.type,
      "x-pristine-delivery": id,
      "x-pristine-timestamp": timestamp,
      "x-pristine-signature": `sha256=${signature}`,
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class WebhookService {
  private cache = new Map<
    string,
    { hooks: IAgentWebhookDocument[]; at: number }
  >();

  public invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  private async hooksFor(workspaceId: string) {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hooks;
    const hooks = await AgentWebhookModel.find({ workspaceId, enabled: true });
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(workspaceId, { hooks, at: Date.now() });
    return hooks;
  }

  /** Fire and forget: deliveries run in the background. */
  public emit(event: GovernanceEvent): void {
    if (!event.workspaceId) return;
    void this.hooksFor(event.workspaceId)
      .then((hooks) =>
        Promise.all(
          hooks
            .filter((hook) => wants(hook, event))
            .map((hook) => this.deliver(hook, event)),
        ),
      )
      .catch((error) =>
        logger.warn("Could not send governance webhooks", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  private async attempt(
    hook: IAgentWebhookDocument,
    event: GovernanceEvent,
  ): Promise<SafePostResult> {
    const { body, headers } = buildDelivery(hook, decrypt(hook.secret), event);
    return safePost(hook.url, body, headers, { allowPrivate: allowPrivate() });
  }

  private async deliver(hook: IAgentWebhookDocument, event: GovernanceEvent) {
    let lastError = "";
    let lastStatus: number | null = null;
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
      try {
        const result = await this.attempt(hook, event);
        lastStatus = result.status;
        if (result.status >= 200 && result.status < 300) {
          await this.record(hook, { ok: true, status: result.status });
          return;
        }
        lastError = `HTTP ${result.status}`;
        // A client error will not change on retry (except rate limiting).
        if (result.status < 500 && result.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (i < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[i]);
    }
    await this.record(hook, {
      ok: false,
      status: lastStatus,
      error: lastError,
    });
  }

  private async record(
    hook: IAgentWebhookDocument,
    result: { ok: boolean; status: number | null; error?: string },
  ) {
    const failures = result.ok ? 0 : hook.consecutiveFailures + 1;
    const disable = failures >= MAX_CONSECUTIVE_FAILURES;
    hook.consecutiveFailures = failures;
    await AgentWebhookModel.updateOne(
      { _id: hook._id },
      {
        $set: {
          lastDeliveryAt: new Date(),
          lastStatus: result.status,
          lastError: result.ok
            ? null
            : (result.error ?? "Failed").slice(0, 300),
          consecutiveFailures: failures,
          ...(disable
            ? {
                enabled: false,
                disabledReason: `Turned off after ${failures} failed deliveries in a row: ${result.error ?? "failed"}`,
              }
            : {}),
        },
      },
    ).catch(() => undefined);
    if (disable) this.invalidate(hook.workspaceId.toString());
  }

  /** One delivery of a sample event, for the "Send test" button. */
  public async test(hook: IAgentWebhookDocument) {
    const event: GovernanceEvent = {
      type: "alert.raised",
      workspaceId: hook.workspaceId.toString(),
      severity: "info",
      summary: "Test event from Agent Governance: this webhook works.",
      data: { test: true },
    };
    try {
      const result = await this.attempt(hook, event);
      const ok = result.status >= 200 && result.status < 300;
      await this.record(hook, {
        ok,
        status: result.status,
        error: ok ? undefined : `HTTP ${result.status}`,
      });
      return { ok, status: result.status, body: result.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(hook, { ok: false, status: null, error: message });
      return { ok: false, status: null, body: message };
    }
  }
}

export default new WebhookService();
