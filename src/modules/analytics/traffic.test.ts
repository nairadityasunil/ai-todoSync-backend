import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { pageKey } from "./services/ai-traffic.service.js";
import { classifyTraffic } from "./traffic.js";

const chrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("AI traffic classification", () => {
  test("people in ordinary browsers", () => {
    assert.deepEqual(classifyTraffic({ userAgent: chrome }), {
      type: "human",
      agent: null,
    });
  });

  test("AI assistants browsing for someone are named", () => {
    const agent = (userAgent: string) => classifyTraffic({ userAgent }).agent;
    assert.equal(
      agent(`${chrome} ChatGPT-User/1.0; +https://openai.com/bot`),
      "ChatGPT",
    );
    assert.equal(
      agent(
        "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
      ),
      "Claude",
    );
    assert.equal(agent(`${chrome} Perplexity-User/1.0`), "Perplexity");
    assert.equal(classifyTraffic({ userAgent: "GPTBot/1.1" }).type, "ai_agent");
  });

  test("automated browsers without a name", () => {
    assert.deepEqual(
      classifyTraffic({
        userAgent: chrome.replace("Chrome/", "HeadlessChrome/"),
      }),
      { type: "automated", agent: null },
    );
    assert.equal(
      classifyTraffic({ userAgent: chrome, webdriver: true }).type,
      "automated",
    );
  });

  test("search crawlers and link previews are not AI agents", () => {
    assert.deepEqual(
      classifyTraffic({
        userAgent:
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      }),
      { type: "crawler", agent: "Google" },
    );
    assert.equal(
      classifyTraffic({ userAgent: "Slackbot-LinkExpanding 1.0" }).agent,
      "Link preview",
    );
    assert.equal(
      classifyTraffic({ userAgent: "acme-spider 2.0" }).type,
      "crawler",
    );
  });

  test("pages are counted without query strings or fragments", () => {
    assert.equal(
      pageKey("https://shop.example.com/pricing?ref=gpt#plans"),
      "https://shop.example.com/pricing",
    );
    assert.equal(pageKey("/docs?x=1"), "/docs");
    assert.equal(pageKey(undefined), null);
  });
});
