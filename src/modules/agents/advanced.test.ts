import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ChangeCounter,
  clampMinutes,
  computeBaseline,
  correlationClass,
  CorrelationWindows,
  diffPolicies,
  effectiveClassification,
  elevationTier,
  labelVerdict,
  percentile,
  playbookMatches,
  rotationStep,
  scoreAnomaly,
  sessionRisk,
  strictestClassification,
  summarizeSimulation,
} from "./advanced.js";

const DAY = 86_400_000;

describe("behaviour baselines", () => {
  test("percentile", () => {
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  });

  test("an agent with 10 days of 5-10 updates a day has a ready baseline", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const rows = [];
    for (let d = 1; d <= 10; d += 1) {
      for (let i = 0; i < 5 + (d % 6); i += 1) {
        rows.push({ at: new Date(now.getTime() - d * DAY + i * 3600_000), action: "task:update", risk: "write", outcome: "allowed", projectId: "p1" });
      }
    }
    const b = computeBaseline(rows, now);
    assert.equal(b.ready, true);
    assert.ok(b.days >= 7);
    assert.equal(b.hourlyP95, 1);
    assert.ok(b.dailyP50 >= 5 && b.dailyP50 <= 10);
    assert.deepEqual(b.actions, ["task:update"]);
    assert.deepEqual(b.projects, ["p1"]);
  });

  test("too little history is not ready", () => {
    const now = new Date();
    const b = computeBaseline([{ at: new Date(now.getTime() - 2 * DAY), action: "task:update", risk: "write", outcome: "allowed" }], now);
    assert.equal(b.ready, false);
    assert.equal(scoreAnomaly(b, { changesLastHour: 500, action: "task:delete", risk: "destructive" }).score, 0);
  });

  test("80 updates in an hour against a usual 2 is held and explained", () => {
    const baseline = { ready: true, hourlyP95: 2, actions: ["task:update"], projects: ["p1"] };
    const a = scoreAnomaly(baseline, { changesLastHour: 80, action: "task:update", projectId: "p1", risk: "write" });
    assert.equal(a.boost, "high");
    assert.match(a.reasons[0], /Volume is 40× baseline/);
  });

  test("normal volume is not an anomaly; reads are never scored", () => {
    const baseline = { ready: true, hourlyP95: 3, actions: ["task:update"], projects: ["p1"] };
    assert.equal(scoreAnomaly(baseline, { changesLastHour: 3, action: "task:update", projectId: "p1", risk: "write" }).boost, null);
    assert.equal(scoreAnomaly(baseline, { changesLastHour: 300, action: "task:list", risk: "read" }).score, 0);
  });

  test("a new action in a new project is held for a person", () => {
    const baseline = { ready: true, hourlyP95: 3, actions: ["task:update"], projects: ["p1"] };
    const a = scoreAnomaly(baseline, { changesLastHour: 1, action: "task:delete", projectId: "p2", risk: "destructive" });
    assert.equal(a.score, 35);
    assert.equal(a.boost, "medium");
    assert.equal(a.reasons.length, 2);
  });

  test("change counter keeps the last hour", () => {
    let t = 0;
    const c = new ChangeCounter(() => t);
    c.add("a");
    c.add("a");
    t = 3_599_000;
    assert.equal(c.add("a"), 3);
    t = 3_700_000;
    assert.equal(c.count("a"), 1);
  });
});

describe("cross-agent correlation", () => {
  test("classes", () => {
    assert.equal(correlationClass({ action: "member:list", risk: "read", isBulk: false }), "people");
    assert.equal(correlationClass({ action: "task:list", risk: "read", isBulk: true }), "export");
    assert.equal(correlationClass({ action: "task:delete", risk: "destructive", isBulk: false }), "delete");
    assert.equal(correlationClass({ action: "task:list", risk: "read", isBulk: false }), null);
    assert.equal(correlationClass({ action: "task:update", risk: "write", isBulk: false }), null);
  });

  test("three agents listing people and exporting within 10 minutes form one incident", () => {
    let t = 0;
    const w = new CorrelationWindows(() => t);
    assert.deepEqual(w.observe({ workspaceId: "w", agentId: "a", agentName: "A", cls: "people" }), []);
    t += 60_000;
    assert.deepEqual(w.observe({ workspaceId: "w", agentId: "b", agentName: "B", cls: "export" }), []);
    t += 60_000;
    const out = w.observe({ workspaceId: "w", agentId: "c", agentName: "C", cls: "export" });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "coordinated_access");
    assert.equal(out[0].severity, "critical");
    assert.deepEqual(out[0].agentIds.sort(), ["a", "b", "c"]);
    // Fires once per window.
    assert.deepEqual(w.observe({ workspaceId: "w", agentId: "c", agentName: "C", cls: "export" }), []);
  });

  test("other workspaces and old events do not count", () => {
    let t = 0;
    const w = new CorrelationWindows(() => t);
    w.observe({ workspaceId: "w", agentId: "a", agentName: "A", cls: "people" });
    w.observe({ workspaceId: "x", agentId: "b", agentName: "B", cls: "people" });
    t += 11 * 60_000;
    w.observe({ workspaceId: "w", agentId: "b", agentName: "B", cls: "people" });
    assert.deepEqual(w.observe({ workspaceId: "w", agentId: "c", agentName: "C", cls: "people" }), []);
  });

  test("two agents deleting in one project", () => {
    const w = new CorrelationWindows(() => 0);
    w.observe({ workspaceId: "w", agentId: "a", agentName: "A", cls: "delete", projectId: "p" });
    const out = w.observe({ workspaceId: "w", agentId: "b", agentName: "B", cls: "delete", projectId: "p" });
    assert.equal(out[0].type, "coordinated_delete");
  });
});

describe("session risk", () => {
  test("new country right after a password reset is high", () => {
    const r = sessionRisk({ newIp: true, newCountry: true, credentialChange: true, concurrent: false });
    assert.equal(r.level, "high");
    assert.equal(r.boost, "high");
    assert.equal(r.reasons.length, 3);
  });
  test("a new address alone is not enough; with a password change it is elevated", () => {
    assert.equal(sessionRisk({ newIp: true, newCountry: false, credentialChange: false, concurrent: false }).level, "normal");
    assert.equal(sessionRisk({ newIp: true, newCountry: false, credentialChange: true, concurrent: false }).level, "elevated");
    assert.equal(sessionRisk({ newIp: false, newCountry: false, credentialChange: true, concurrent: false }).level, "normal");
  });
});

describe("data classification", () => {
  test("inheritance", () => {
    assert.equal(effectiveClassification(null, "confidential"), "confidential");
    assert.equal(effectiveClassification("restricted", "public"), "restricted");
    assert.equal(effectiveClassification(undefined, undefined), "internal");
    assert.equal(strictestClassification(["internal", "restricted", "confidential"]), "restricted");
  });
  test("confidential content with personal data never goes to a model", () => {
    assert.equal(labelVerdict({ label: "confidential", risk: "read", toModel: true, leaves: false, dlpFindings: 1 }).effect, "deny");
    assert.equal(labelVerdict({ label: "confidential", risk: "read", toModel: true, leaves: false, dlpFindings: 0 }).effect, "allow");
    assert.equal(labelVerdict({ label: "internal", risk: "read", toModel: true, leaves: false, dlpFindings: 3 }).effect, "allow");
  });
  test("restricted data never leaves and its changes are high risk", () => {
    assert.equal(labelVerdict({ label: "restricted", risk: "read", toModel: true, leaves: false, dlpFindings: 0 }).effect, "deny");
    assert.equal(labelVerdict({ label: "restricted", risk: "read", toModel: false, leaves: true, dlpFindings: 0 }).effect, "deny");
    assert.equal(labelVerdict({ label: "restricted", risk: "write", toModel: false, leaves: false, dlpFindings: 0 }).boost, "high");
    assert.equal(labelVerdict({ label: "confidential", risk: "write", toModel: false, leaves: false, dlpFindings: 0 }).boost, "medium");
    assert.equal(labelVerdict({ label: "confidential", risk: "read", toModel: false, leaves: false, dlpFindings: 0 }).boost, null);
  });
});

describe("just-in-time access", () => {
  test("tiers", () => {
    assert.equal(elevationTier(["analytics:read"]), "low");
    assert.equal(elevationTier(["work:write"]), "medium");
    assert.equal(elevationTier(["analytics:read"], "high"), "high");
    assert.equal(elevationTier(["analytics:read"], "low", true), "medium");
    assert.equal(elevationTier(["workspace:admin"]), "forbidden");
  });
  test("durations are clamped", () => {
    assert.equal(clampMinutes(30, 60), 30);
    assert.equal(clampMinutes(600, 60), 60);
    assert.equal(clampMinutes(1, 60), 5);
    assert.equal(clampMinutes("x", 60), 30);
  });
});

describe("key lifecycle", () => {
  const now = new Date("2026-11-12T00:00:00Z");
  const issued = (days: number) => new Date(now.getTime() - days * DAY);
  test("an 89-day-old low-risk key is rotated automatically", () => {
    assert.equal(rotationStep({ issuedAt: issued(89.5), maxAgeDays: 90, mode: "auto", riskLevel: "low", alreadyNotified: true, now }), "rotate");
  });
  test("owners are warned in the last week", () => {
    assert.equal(rotationStep({ issuedAt: issued(80), maxAgeDays: 90, mode: "auto", riskLevel: "low", alreadyNotified: false, now }), "none");
    assert.equal(rotationStep({ issuedAt: issued(84), maxAgeDays: 90, mode: "auto", riskLevel: "low", alreadyNotified: false, now }), "notify");
    assert.equal(rotationStep({ issuedAt: issued(84), maxAgeDays: 90, mode: "notify", riskLevel: "low", alreadyNotified: true, now }), "none");
    assert.equal(rotationStep({ issuedAt: issued(100), maxAgeDays: 90, mode: "notify", riskLevel: "low", alreadyNotified: false, now }), "notify");
  });
  test("high-risk and vendor keys need a person to confirm", () => {
    assert.equal(rotationStep({ issuedAt: issued(89.5), maxAgeDays: 90, mode: "auto", riskLevel: "high", alreadyNotified: false, now }), "confirm");
    assert.equal(rotationStep({ issuedAt: issued(89.5), maxAgeDays: 90, mode: "auto", riskLevel: "low", isVendor: true, alreadyNotified: false, now }), "confirm");
  });
  test("off", () => {
    assert.equal(rotationStep({ issuedAt: issued(400), maxAgeDays: 90, mode: "off", alreadyNotified: false, now }), "none");
  });
});

describe("policy versions and simulation", () => {
  test("diff lists changed fields only", () => {
    const a = { name: "Deletes", effect: "require_approval", mode: "advisory", priority: 100, enabled: true, match: { tools: ["*:delete"], projectIds: [] } };
    const b = { ...a, mode: "enforce", match: { tools: ["*:delete"], minRisk: "destructive" } };
    assert.deepEqual(diffPolicies(a, b), [
      { field: "match.minRisk", before: null, after: "destructive" },
      { field: "mode", before: "advisory", after: "enforce" },
    ]);
    assert.equal(diffPolicies(null, a).length, 6);
    assert.deepEqual(diffPolicies(a, a), []);
  });
  test("simulation summary", () => {
    const s = summarizeSimulation([
      { before: "allow", after: "require_approval" },
      { before: "allow", after: "allow" },
      { before: "allow", after: "require_approval" },
      { before: "require_approval", after: "deny" },
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.proposed.require_approval, 2);
    assert.deepEqual(s.changed, { "allow→require_approval": 2, "require_approval→deny": 1 });
  });
  test("playbook triggers", () => {
    assert.equal(playbookMatches({ types: ["threat"], minSeverity: "critical" }, { type: "threat", severity: "critical" }), true);
    assert.equal(playbookMatches({ types: ["threat"], minSeverity: "critical" }, { type: "threat", severity: "warning" }), false);
    assert.equal(playbookMatches({ types: ["dlp"], minSeverity: "info" }, { type: "threat", severity: "critical" }), false);
  });
});
