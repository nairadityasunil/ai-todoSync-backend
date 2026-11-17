import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hostnameOf, matchHost, matchName, matchPackage } from "./catalog.js";
import { scanCode } from "./code-scan.js";
import { assessRisk } from "./risk.js";
import { isBroadGrant, parseLogRows, resolveTarget } from "./signals.js";

describe("catalog matching", () => {
  it("reads a host out of a URL, port and www", () => {
    assert.equal(
      hostnameOf("https://www.ChatGPT.com:443/c/abc?x=1"),
      "chatgpt.com",
    );
    assert.equal(hostnameOf("user@host.example.com"), "host.example.com");
    assert.equal(hostnameOf("not a host"), null);
    assert.equal(hostnameOf(42), null);
  });
  it("tells ChatGPT from the OpenAI API and matches subdomains", () => {
    assert.equal(matchHost("chat.openai.com")?.key, "chatgpt");
    assert.equal(matchHost("api.openai.com")?.key, "openai_api");
    assert.equal(matchHost("eu.api.openai.com")?.key, "openai_api");
    assert.equal(
      matchHost("bedrock-runtime.us-east-1.amazonaws.com")?.key,
      "aws_bedrock",
    );
  });
  it("does not match look-alike hosts", () => {
    assert.equal(matchHost("notopenai.com"), null);
    assert.equal(matchHost("claude.ai.evil.example"), null);
    assert.equal(matchHost("example.com"), null);
  });
  it("matches names and packages", () => {
    assert.equal(matchName("Otter.ai")?.key, "otter");
    assert.equal(matchName("Fireflies.ai Notetaker")?.key, "fireflies");
    assert.equal(matchPackage("@anthropic-ai/sdk")?.key, "anthropic_api");
    assert.equal(matchPackage("left-pad"), null);
  });
});

describe("resolving evidence", () => {
  it("resolves a known host with full confidence", () => {
    const r = resolveTarget("network", "https://claude.ai/chat");
    assert.equal(r?.toolKey, "claude");
    assert.equal(r?.confidence, 1);
  });
  it("keeps an unknown AI-looking host at low confidence and ignores ordinary hosts", () => {
    assert.equal(
      resolveTarget("network", "mycompany-gpt.example.io")?.catalog,
      false,
    );
    assert.equal(resolveTarget("network", "intranet.example.com"), null);
  });
  it("does not turn every OAuth app into an AI tool", () => {
    assert.equal(resolveTarget("oauth", "Calendar Sync"), null);
    assert.equal(resolveTarget("oauth", "Acme AI Notes")?.kind, "unknown");
    assert.equal(resolveTarget("oauth", "Otter.ai")?.toolKey, "otter");
  });
  it("flags grants that reach company data", () => {
    assert.equal(
      isBroadGrant(["https://www.googleapis.com/auth/gmail.readonly"]),
      true,
    );
    assert.equal(isBroadGrant(["openid", "profile"]), false);
  });
});

describe("log parsing", () => {
  it("reads a CSV with a header, bytes and users", () => {
    const { rows, skipped } = parseLogRows(
      "time,user,host,bytes_out\n2026-11-01T10:00:00Z,Ada@Example.com,chat.openai.com,2048\nbad row,,,\n",
    );
    assert.equal(rows.length, 1);
    assert.equal(skipped, 1);
    assert.equal(rows[0].user, "ada@example.com");
    assert.equal(rows[0].bytesOut, 2048);
    assert.equal(rows[0].at?.toISOString(), "2026-11-01T10:00:00.000Z");
  });
  it("reads a plain list of hosts", () => {
    assert.equal(parseLogRows("claude.ai\nperplexity.ai\n").rows.length, 2);
  });
  it("ignores a future timestamp", () => {
    const { rows } = parseLogRows(
      "host,time\nclaude.ai,2099-01-01T00:00:00Z\n",
    );
    assert.equal(rows[0].at, undefined);
  });
});

describe("code scan", () => {
  it("finds AI packages in a manifest, requirements and imports", () => {
    const f = scanCode([
      {
        path: "package.json",
        content: JSON.stringify({
          dependencies: { openai: "^4", express: "^4" },
          devDependencies: { "@anthropic-ai/sdk": "1" },
        }),
      },
      {
        path: "requirements.txt",
        content: "requests==2\nlangchain>=0.1\n# anthropic\n",
      },
      {
        path: "src/a.py",
        content: "import ollama\nfrom transformers import pipeline\n",
      },
      {
        path: "src/b.ts",
        content:
          'import { generateText } from "ai";\nimport x from "@langchain/core/messages";\n',
      },
    ]);
    const names = f
      .filter((x) => x.type === "package")
      .map((x) => (x.type === "package" ? x.tool.key : ""));
    for (const k of [
      "openai_api",
      "anthropic_api",
      "langchain",
      "ollama",
      "huggingface",
      "vercel_ai",
    ])
      assert.ok(names.includes(k), k);
    assert.ok(!names.includes("express"));
  });
  it("finds keys but never returns the whole key", () => {
    const key = "sk-ant-api03-" + "A".repeat(40);
    const f = scanCode([{ path: "config.js", content: `const k = "${key}";` }]);
    assert.equal(f.length, 1);
    assert.equal(f[0].type, "key");
    assert.ok(!JSON.stringify(f).includes(key));
    assert.ok(!JSON.stringify(f).includes("AAAAAAAAAAAA"));
  });
  it("skips node_modules and the same key twice in one file", () => {
    const key = "sk-proj-" + "b".repeat(30);
    const f = scanCode([
      { path: "node_modules/x/index.js", content: `"${key}"` },
      { path: "a.env", content: `${key}\n${key}` },
    ]);
    assert.equal(f.length, 1);
  });
});

describe("risk", () => {
  const base = {
    kind: "assistant" as const,
    status: "unreviewed" as const,
    users: 3,
    bytesOut: 0,
    uploads: 0,
    personalShare: 0,
    hasSecret: false,
    hasBroadGrant: false,
    sources: 1,
    vendorApproved: false,
    recentlyUsed: true,
  };
  it("scores a quiet tool lower than one with uploads, a key and a broad grant", () => {
    const quiet = assessRisk(base);
    const loud = assessRisk({
      ...base,
      uploads: 4,
      hasSecret: true,
      hasBroadGrant: true,
      bytesOut: 20 * 1024 * 1024,
      personalShare: 0.9,
    });
    assert.ok(loud.score > quiet.score + 40);
    assert.ok(["high", "critical"].includes(loud.level));
  });
  it("lowers risk once sanctioned and raises it when a prohibited tool is still used", () => {
    assert.ok(
      assessRisk({ ...base, status: "sanctioned" }).score <
        assessRisk(base).score,
    );
    assert.ok(
      assessRisk({ ...base, status: "prohibited" }).score >
        assessRisk(base).score,
    );
  });
  it("stays within 0 to 100 and explains itself", () => {
    const r = assessRisk({
      ...base,
      kind: "agent_platform",
      users: 100000,
      uploads: 9,
      hasSecret: true,
      hasBroadGrant: true,
      bytesOut: 1e11,
      personalShare: 1,
      sources: 5,
    });
    assert.ok(r.score <= 100 && r.score >= 0);
    assert.ok(r.factors.length >= 5);
  });
});
