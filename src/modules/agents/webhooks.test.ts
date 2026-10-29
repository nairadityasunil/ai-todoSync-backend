import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { describe } from "node:test";

import {
  assertSafeUrl,
  isPrivateAddress,
  UnsafeUrlError,
} from "../../utils/safe-http.js";
import { buildDelivery, wants } from "./webhooks.service.js";

describe("Webhook URL safety", () => {
  test("private, loopback, link-local and metadata addresses are refused", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    assert.equal(isPrivateAddress("93.184.216.34"), false);
    assert.equal(isPrivateAddress("2606:4700::1111"), false);
  });

  test("only https URLs without credentials or local names", () => {
    assert.equal(
      assertSafeUrl("https://hooks.slack.com/services/T/B/x").hostname,
      "hooks.slack.com",
    );
    for (const url of [
      "http://example.com/hook",
      "https://user:pw@example.com/hook",
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://metadata.internal/latest",
      "ftp://example.com",
      "not a url",
    ]) {
      assert.throws(() => assertSafeUrl(url), UnsafeUrlError, url);
    }
    assert.equal(
      assertSafeUrl("http://127.0.0.1:9000/x", { allowPrivate: true }).port,
      "9000",
    );
  });
});

describe("Webhook delivery", () => {
  const hook = {
    enabled: true,
    events: ["alert.raised", "approval.requested"] as const,
    minSeverity: "warning" as const,
  };

  test("events and alert severity are filtered", () => {
    const want = (type: string, severity?: "info" | "warning" | "critical") =>
      wants(
        { ...hook, events: [...hook.events] },
        {
          type: type as "alert.raised",
          severity,
        },
      );
    assert.equal(want("alert.raised", "critical"), true);
    assert.equal(want("alert.raised", "warning"), true);
    assert.equal(want("alert.raised", "info"), false);
    assert.equal(want("approval.requested"), true);
    assert.equal(want("activity.blocked"), false);
    assert.equal(
      wants(
        { ...hook, events: [...hook.events], enabled: false },
        {
          type: "alert.raised",
          severity: "critical",
        },
      ),
      false,
    );
  });

  test("JSON deliveries are signed over the timestamp and body", () => {
    const now = new Date("2026-10-29T10:00:00Z");
    const { body, headers } = buildDelivery(
      { format: "json" },
      "whsec_test",
      {
        type: "alert.raised",
        workspaceId: "w1",
        severity: "critical",
        summary: "Budget used up",
        data: { a: 1 },
      },
      now,
    );
    const expected = createHmac("sha256", "whsec_test")
      .update(`${headers["x-pristine-timestamp"]}.${body}`)
      .digest("hex");
    assert.equal(headers["x-pristine-signature"], `sha256=${expected}`);
    assert.equal(headers["x-pristine-event"], "alert.raised");
    assert.equal(JSON.parse(body).summary, "Budget used up");
  });

  test("Slack deliveries are plain messages", () => {
    const { body, headers } = buildDelivery({ format: "slack" }, "s", {
      type: "alert.raised",
      workspaceId: "w1",
      severity: "warning",
      summary: "Unregistered agent: curl",
      data: {},
    });
    assert.equal(JSON.parse(body).text, "[Warning] Unregistered agent: curl");
    assert.deepEqual(headers, {});
  });
});
