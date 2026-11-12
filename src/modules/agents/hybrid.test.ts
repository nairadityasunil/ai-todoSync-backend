import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createZip, crc32 } from "../../utils/zip.js";
import { driftedControls } from "./compliance-drift.js";
import {
  defaultDecision,
  dlpVerdict,
  EXISTING_WORKSPACE_GOVERNANCE,
  incidentSuggestions,
  isBulkRead,
  luhn,
  NEW_WORKSPACE_GOVERNANCE,
  normalizeGovernance,
  recommend,
  scanForDlp,
  ThreatWindows,
  tierFor,
} from "./hybrid.js";

describe("hybrid governance: settings", () => {
  test("new workspaces get the hybrid defaults; older ones keep advisory behaviour", () => {
    assert.equal(NEW_WORKSPACE_GOVERNANCE.mode, "auto_low_risk");
    assert.equal(NEW_WORKSPACE_GOVERNANCE.dlpMode, "enforce");
    assert.equal(normalizeGovernance(undefined).mode, "advisory");
    assert.equal(normalizeGovernance(undefined).dlpMode, "monitor");
    assert.equal(normalizeGovernance(NEW_WORKSPACE_GOVERNANCE).mode, "auto_low_risk");
  });

  test("bad stored values fall back and numbers are clamped", () => {
    const s = normalizeGovernance({ mode: "yolo", autoApproveRepeatDays: 999, keyMaxAgeDays: -5, allowedDataRegions: ["EU", 3, " US "] });
    assert.equal(s.mode, EXISTING_WORKSPACE_GOVERNANCE.mode);
    assert.equal(s.autoApproveRepeatDays, 90);
    assert.equal(s.keyMaxAgeDays, 0);
    assert.deepEqual(s.allowedDataRegions, ["EU", "US"]);
  });
});

describe("hybrid governance: decision engine", () => {
  test("tier is the riskier of the action and the agent; reads by risky agents stay low", () => {
    assert.equal(tierFor({ risk: "read", agentRiskLevel: "high" }), "low");
    assert.equal(tierFor({ risk: "read", agentRiskLevel: "critical" }), "medium");
    assert.equal(tierFor({ risk: "write", agentRiskLevel: "low" }), "low");
    assert.equal(tierFor({ risk: "write", agentRiskLevel: "medium" }), "low");
    assert.equal(tierFor({ risk: "write", agentRiskLevel: "high" }), "high");
    assert.equal(tierFor({ risk: "destructive", agentRiskLevel: "low" }), "high");
    assert.equal(tierFor({ risk: "write", agentRiskLevel: "critical" }), "critical");
  });

  test("Enforce + auto low-risk: low runs, medium and high wait, critical blocks and suspends", () => {
    const s = { mode: "auto_low_risk" as const, criticalAutoSuspend: true };
    assert.equal(defaultDecision(s, "low", false).effect, "allow");
    assert.equal(defaultDecision(s, "medium", false).effect, "require_approval");
    assert.equal(defaultDecision(s, "high", false).effect, "require_approval");
    const critical = defaultDecision(s, "critical", false);
    assert.equal(critical.effect, "deny");
    assert.equal(critical.suspend, true);
  });

  test("Full enforce holds every change, still allows reads", () => {
    const s = { mode: "full_enforce" as const, criticalAutoSuspend: false };
    assert.equal(defaultDecision(s, "low", false).effect, "require_approval");
    assert.equal(defaultDecision(s, "low", true).effect, "allow");
    assert.equal(defaultDecision(s, "critical", false).suspend, false);
  });

  test("Advisory only logs what enforcement would do", () => {
    const d = defaultDecision({ mode: "advisory", criticalAutoSuspend: true }, "high", false);
    assert.equal(d.effect, "allow");
    assert.equal(d.wouldHave, "require_approval");
    assert.equal(defaultDecision({ mode: "advisory", criticalAutoSuspend: true }, "low", false).wouldHave, undefined);
  });

  test("recommendation weighs history, risk, DLP and threats", () => {
    const base = { tier: "medium" as const, risk: "write" as const, agentRiskLevel: "low", agentKind: "api_key", approvedBefore: 0, rejectedBefore: 0, dlpFindings: 0, threatSignals: 0 };
    assert.equal(recommend({ ...base, approvedBefore: 3 }).decision, "approve");
    assert.equal(recommend({ ...base, risk: "destructive", tier: "high" }).decision, "reject");
    assert.equal(recommend({ ...base, approvedBefore: 1, dlpFindings: 1 }).decision, "reject");
    assert.ok(recommend({ ...base, threatSignals: 2 }).reasons.some((r) => /threat/i.test(r)));
  });
});

describe("hybrid governance: DLP", () => {
  test("finds secrets, card numbers (Luhn) and personal data", () => {
    const findings = scanForDlp({
      prompt: "Use sk-live-abcdefghijklmnop1234 for jane@example.com, card 4111 1111 1111 1111, order 1234 5678 9012 3456",
    });
    const types = findings.map((f) => f.type);
    assert.ok(types.includes("credential"));
    assert.ok(types.includes("email"));
    assert.equal(findings.find((f) => f.type === "card_number")?.count, 1);
    assert.equal(luhn("4111111111111111"), true);
    assert.equal(luhn("1234567890123456"), false);
  });

  test("links to unapproved hosts are flagged; approved ones and subdomains are not", () => {
    const findings = scanForDlp({ body: "see https://api.vendor.com/x and https://evil.example/y" }, { allowedHosts: ["vendor.com"] });
    const external = findings.find((f) => f.type === "external_destination");
    assert.equal(external?.count, 1);
    assert.match(external?.label ?? "", /evil\.example/);
  });

  test("enforce blocks high-confidence, holds medium; monitor never blocks", () => {
    const high = [{ type: "credential" as const, label: "API key", confidence: "high" as const, count: 1 }];
    const medium = [{ type: "email" as const, label: "Email address", confidence: "medium" as const, count: 2 }];
    assert.equal(dlpVerdict("enforce", high).effect, "deny");
    assert.equal(dlpVerdict("enforce", medium).effect, "require_approval");
    assert.equal(dlpVerdict("monitor", high).effect, "allow");
    assert.equal(dlpVerdict("enforce", []).effect, "allow");
  });

  test("bulk reads: exports and very large pages", () => {
    assert.equal(isBulkRead("GET", "/api/agents/activity/export?format=csv"), true);
    assert.equal(isBulkRead("GET", "/api/tasks?limit=1000"), true);
    assert.equal(isBulkRead("GET", "/api/tasks?limit=50"), false);
    assert.equal(isBulkRead("POST", "/api/vendors/export"), false);
  });
});

describe("hybrid governance: threats", () => {
  test("a key used from three addresses within ten minutes is key abuse, raised once", () => {
    let now = 0;
    const w = new ThreatWindows(() => now);
    const call = (ip: string) => w.observe({ agentId: "a", agentName: "Bot", ip, risk: "read", isList: false, isBulk: false });
    assert.equal(call("1.1.1.1").length, 0);
    now += 60_000;
    assert.equal(call("2.2.2.2").length, 0);
    now += 60_000;
    const third = call("3.3.3.3");
    assert.equal(third[0]?.type, "key_abuse");
    assert.equal(third[0]?.severity, "critical");
    now += 1000;
    assert.equal(call("3.3.3.3").length, 0);
  });

  test("bulk deletes trip mass delete and keep blocking further deletes", () => {
    let now = 0;
    const w = new ThreatWindows(() => now);
    const signals = [];
    for (let i = 0; i < 5; i += 1) {
      now += 1000;
      signals.push(...w.observe({ agentId: "b", agentName: "Bot", risk: "destructive", isList: false, isBulk: false }));
    }
    assert.equal(signals.filter((s) => s.type === "mass_delete").length, 1);
    assert.equal(w.deletingInBulk("b"), true);
    now += 6 * 60_000;
    assert.equal(w.deletingInBulk("b"), false);
  });

  test("repeated escalation attempts and blocks are separate signals", () => {
    const w = new ThreatWindows(() => 0);
    const esc = [1, 2, 3].flatMap(() => w.observe({ agentId: "c", agentName: "Bot", risk: "write", isList: false, isBulk: false, outcome: "escalation" }));
    assert.deepEqual(esc.map((s) => s.type), ["privilege_escalation"]);
    const blocks = [1, 2, 3, 4, 5].flatMap(() => w.observe({ agentId: "c", agentName: "Bot", risk: "write", isList: false, isBulk: false, outcome: "blocked" }));
    assert.deepEqual(blocks.map((s) => s.type), ["repeated_blocks"]);
  });

  test("incident suggestions always offer re-approval", () => {
    for (const trigger of ["key_abuse", "mass_delete", "dlp", "something_else"]) {
      assert.ok(incidentSuggestions(trigger).some((s) => /approve/i.test(s)), trigger);
    }
  });
});

describe("compliance", () => {
  test("drift: only controls that were met and no longer are", () => {
    const drifted = driftedControls(
      [{ id: "a", status: "met" }, { id: "b", status: "gap" }, { id: "c", status: "met" }],
      [{ id: "a", title: "A", status: "partial" }, { id: "b", title: "B", status: "gap" }, { id: "c", title: "C", status: "met" }],
    );
    assert.deepEqual(drifted.map((c) => c.id), ["a"]);
  });

  test("evidence pack zip has valid headers and CRCs", () => {
    assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
    const zip = createZip([{ name: "a.txt", content: "hello" }, { name: "b.csv", content: "x,y\n1,2" }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
    assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2);
  });
});
