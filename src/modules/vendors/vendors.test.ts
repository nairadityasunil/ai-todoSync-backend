import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { toCsv } from "../../utils/csv.js";
import {
  providerIdsFor,
  unknownVendor,
  vendorForAgent,
  vendorForUrl,
} from "./catalog.js";
import { contentMatches, safeFileName } from "./evidence.service.js";
import { missingAnswers, QUESTIONS, sanitizeAnswers } from "./questionnaire.js";
import {
  expiresWithin,
  levelFor,
  nextReviewDate,
  scoreVendor,
  type VendorRiskInput,
} from "./risk.js";

describe("Vendor discovery", () => {
  test("AI providers map to their company; self-hosted Ollama does not", () => {
    assert.equal(
      vendorForAgent({ kind: "ai_provider", fingerprint: "provider:openai" })
        ?.key,
      "openai",
    );
    assert.equal(
      vendorForAgent({ kind: "ai_provider", fingerprint: "provider:anthropic" })
        ?.key,
      "anthropic",
    );
    assert.equal(
      vendorForAgent({ kind: "ai_provider", fingerprint: "provider:ollama" }),
      null,
    );
    const custom = vendorForAgent({
      kind: "ai_provider",
      fingerprint: "provider:Acme LLM",
    });
    assert.equal(custom?.key, "acme-llm");
    assert.equal(custom?.category, "ai_model");
  });

  test("ChatGPT sessions belong to OpenAI", () => {
    assert.equal(vendorForAgent({ kind: "chatgpt" })?.key, "openai");
  });

  test("known MCP clients map to the catalog; unknown ones become AI vendors", () => {
    assert.equal(
      vendorForAgent({ kind: "mcp_client", clientName: "Claude Desktop" })?.key,
      "anthropic",
    );
    assert.equal(
      vendorForAgent({ kind: "mcp_client", clientName: "Cursor" })?.key,
      "cursor",
    );
    const unknown = vendorForAgent({
      kind: "mcp_client",
      clientName: "Some New IDE",
    });
    assert.equal(unknown?.key, "some-new-ide");
    assert.equal(unknown?.category, "ai_assistant");
  });

  test("generic tools, unknown scripts, API keys and companions are not vendors", () => {
    assert.equal(
      vendorForAgent({ kind: "detected", clientName: "curl/8.4.0" }),
      null,
    );
    assert.equal(
      vendorForAgent({ kind: "detected", clientName: "python-requests/2.31" }),
      null,
    );
    assert.equal(
      vendorForAgent({ kind: "detected", clientName: "my-script" }),
      null,
    );
    assert.equal(vendorForAgent({ kind: "mcp_client", clientName: "" }), null);
    assert.equal(vendorForAgent({ kind: "api_key", clientName: "x" }), null);
    assert.equal(vendorForAgent({ kind: "companion" }), null);
  });

  test("webhook destinations map by host", () => {
    assert.equal(
      vendorForUrl("https://hooks.slack.com/services/T/B/X")?.key,
      "slack",
    );
    assert.equal(vendorForUrl("https://example.org/hook"), null);
    assert.equal(vendorForUrl("not a url"), null);
  });

  test("unknown vendor names are slugged and bounded", () => {
    const vendor = unknownVendor("  Ünïcode !! Tool  ", "other");
    assert.match(vendor.key, /^[a-z0-9-]+$/);
    assert.equal(unknownVendor("!!!", "other").key, "unknown");
    assert.ok(unknownVendor("x".repeat(200), "other").key.length <= 60);
  });

  test("provider ids for spend", () => {
    assert.ok(providerIdsFor("openai").includes("openai"));
    assert.deepEqual(providerIdsFor("nobody"), []);
  });
});

describe("Vendor questionnaire", () => {
  test("keeps only known questions with valid values", () => {
    const answers = sanitizeAnswers({
      trains_on_data: "no",
      encryption: "maybe",
      retention: "forever-and-ever",
      unknown_question: "yes",
      dpa_signed: "yes",
      data_location: "  EU  ",
    });
    assert.equal(answers.trains_on_data, "no");
    assert.equal(answers.dpa_signed, "yes");
    assert.equal(answers.data_location, "EU");
    assert.equal(answers.encryption, undefined);
    assert.equal(answers.retention, undefined);
    assert.equal(answers.unknown_question, undefined);
    assert.deepEqual(sanitizeAnswers(null), {});
    assert.deepEqual(sanitizeAnswers("x"), {});
  });

  test("lists required questions still unanswered", () => {
    const required = QUESTIONS.filter((q) => q.required).map((q) => q.id);
    assert.deepEqual(missingAnswers({}), required);
    const all = Object.fromEntries(
      QUESTIONS.map((q) => [q.id, q.options?.[0].value ?? "yes"]),
    );
    assert.deepEqual(missingAnswers(sanitizeAnswers(all)), []);
  });
});

describe("Vendor risk", () => {
  const base: VendorRiskInput = {
    category: "ai_model",
    tier: 1,
    scopes: ["ai:execute"],
    receivesContent: true,
    allProjects: false,
    answers: {},
    evidence: [],
    workspaceMasksAiData: false,
    now: new Date("2026-06-01T00:00:00Z"),
  };
  const codes = (input: VendorRiskInput) =>
    scoreVendor(input).factors.map((f) => f.code);

  test("an unassessed AI provider is high risk", () => {
    const result = scoreVendor(base);
    // content 30 + write 15 + tier 1 20 + AI 5 = 70 inherent
    assert.equal(result.inherent, 70);
    // + not assessed 10 + no DPA 10
    assert.equal(result.residual, 90);
    assert.equal(result.level, "critical");
    assert.ok(codes(base).includes("not_assessed"));
    assert.ok(codes(base).includes("no_dpa"));
  });

  test("controls from the assessment and evidence lower residual risk", () => {
    const input: VendorRiskInput = {
      ...base,
      answers: {
        trains_on_data: "no",
        retention: "zero",
        incident_notice: "72h",
        encryption: "yes",
        dpa_signed: "yes",
      },
      assessmentCompletedAt: new Date("2026-05-01T00:00:00Z"),
      nextReviewAt: new Date("2027-05-01T00:00:00Z"),
      evidence: ["soc2"],
      workspaceMasksAiData: true,
    };
    const result = scoreVendor(input);
    assert.equal(result.inherent, 70);
    // 70 - 15 - 10 - 5 - 5 - 15 (cert) - 15 (dpa) - 10 (masking) = -5 → 0
    assert.equal(result.residual, 0);
    assert.equal(result.level, "low");
    for (const code of ["no_training", "certified", "dpa", "masking"])
      assert.ok(codes(input).includes(code), code);
  });

  test("gaps add risk: training on data, overdue review, expired DPA", () => {
    const input: VendorRiskInput = {
      ...base,
      answers: { trains_on_data: "yes", dpa_signed: "yes" },
      assessmentCompletedAt: new Date("2024-01-01T00:00:00Z"),
      nextReviewAt: new Date("2025-01-01T00:00:00Z"),
      dpaExpiresAt: new Date("2026-01-01T00:00:00Z"),
    };
    const found = codes(input);
    assert.ok(found.includes("trains_on_data"));
    assert.ok(found.includes("review_overdue"));
    assert.ok(found.includes("no_dpa"));
    assert.ok(!found.includes("dpa"));
  });

  test("inherent risk follows access and tier", () => {
    const tool: VendorRiskInput = {
      ...base,
      category: "observability",
      tier: 3,
      scopes: ["task:read"],
      receivesContent: false,
    };
    assert.equal(scoreVendor(tool).inherent, 5);
    assert.ok(
      codes({ ...tool, scopes: ["workspace:admin"] }).includes("admin_access"),
    );
    assert.ok(codes({ ...tool, allProjects: true }).includes("all_projects"));
    assert.ok(!codes(tool).includes("no_dpa"));
  });

  test("levels, review cadence and expiry windows", () => {
    assert.equal(levelFor(80), "critical");
    assert.equal(levelFor(50), "high");
    assert.equal(levelFor(25), "medium");
    assert.equal(levelFor(24), "low");
    const from = new Date("2026-03-15T00:00:00Z");
    assert.equal(
      nextReviewDate(1, from).toISOString(),
      "2027-03-15T00:00:00.000Z",
    );
    assert.equal(
      nextReviewDate(3, from).toISOString(),
      "2029-03-15T00:00:00.000Z",
    );
    const now = new Date("2026-06-01T00:00:00Z");
    assert.equal(
      expiresWithin(new Date("2026-06-20T00:00:00Z"), 30, now),
      true,
    );
    assert.equal(
      expiresWithin(new Date("2026-08-01T00:00:00Z"), 30, now),
      false,
    );
    assert.equal(
      expiresWithin(new Date("2026-05-01T00:00:00Z"), 30, now),
      false,
    );
    assert.equal(expiresWithin(null, 30, now), false);
  });
});

describe("Vendor evidence", () => {
  test("content must match the declared type", () => {
    const pdf = Buffer.from("%PDF-1.7\n...");
    assert.equal(contentMatches("application/pdf", pdf), true);
    assert.equal(contentMatches("image/png", pdf), false);
    assert.equal(
      contentMatches("application/pdf", Buffer.from("<html>")),
      false,
    );
    assert.equal(contentMatches("text/plain", Buffer.from("hello")), true);
    assert.equal(
      contentMatches("text/plain", Buffer.from([0x4d, 0x00])),
      false,
    );
    assert.equal(contentMatches("text/html", Buffer.from("<b>")), false);
    assert.equal(
      contentMatches(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]),
      ),
      true,
    );
  });

  test("file names are safe and use the type's extension", () => {
    assert.equal(
      safeFileName("../../etc/passwd.pdf", "application/pdf"),
      "etcpasswd.pdf",
    );
    assert.equal(
      safeFileName('SOC 2 "report"\r\n.exe', "application/pdf"),
      "SOC 2 report.pdf",
    );
    assert.equal(safeFileName("", "image/png"), "evidence.png");
    assert.equal(safeFileName("a.html", "text/plain"), "a.txt");
  });
});

describe("CSV export", () => {
  test("neutralises spreadsheet formulas and quotes cells", () => {
    const csv = toCsv(["name", "note"], [["=HYPERLINK(1)", 'say "hi", ok']]);
    assert.equal(csv.split("\n")[1], `'=HYPERLINK(1),"say ""hi"", ok"`);
  });
});
