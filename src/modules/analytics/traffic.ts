/**
 * Who is behind SDK traffic: a person, a named AI agent (ChatGPT, Claude,
 * Perplexity browsing on someone's behalf), some other automated browser, or
 * a crawler. Pure, so it can be unit tested and updated without an SDK
 * release; the SDK only reports what the browser says about itself.
 */

export type TrafficType = "human" | "ai_agent" | "automated" | "crawler";

export interface TrafficSignals {
  /** User agent of the request (or as reported by the SDK). */
  userAgent?: string | null;
  /** navigator.webdriver as reported by the SDK. */
  webdriver?: boolean | null;
}

export interface TrafficClass {
  type: TrafficType;
  /** Display name of the agent or crawler, when known. */
  agent: string | null;
}

/** AI assistants and agents that fetch or browse pages for a person. */
const AI_AGENTS: Array<[RegExp, string]> = [
  [/ChatGPT-User|ChatGPT Agent|OAI-SearchBot|GPTBot/i, "ChatGPT"],
  [/Claude-User|Claude-SearchBot|ClaudeBot|Claude-Web|anthropic-ai/i, "Claude"],
  [/Perplexity-User|PerplexityBot/i, "Perplexity"],
  [/Google-Extended|GoogleAgent-Mariner|Gemini-Deep-Research/i, "Gemini"],
  [/MistralAI-User/i, "Mistral"],
  [/DuckAssistBot/i, "DuckDuckGo AI"],
  [/Meta-ExternalAgent|Meta-ExternalFetcher/i, "Meta AI"],
  [/Amazonbot|Novaact/i, "Amazon"],
  [/cohere-ai/i, "Cohere"],
  [/YouBot/i, "You.com"],
  [/browser-use/i, "browser-use"],
];

const CRAWLERS: Array<[RegExp, string]> = [
  [/Googlebot|Google-InspectionTool|AdsBot-Google/i, "Google"],
  [/bingbot|BingPreview/i, "Bing"],
  [/DuckDuckBot/i, "DuckDuckGo"],
  [/YandexBot/i, "Yandex"],
  [/Baiduspider/i, "Baidu"],
  [/Applebot/i, "Apple"],
  [/Bytespider/i, "ByteDance"],
  [/CCBot/i, "Common Crawl"],
  [
    /facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot/i,
    "Link preview",
  ],
  [/AhrefsBot|SemrushBot|MJ12bot|DotBot/i, "SEO crawler"],
];

const HEADLESS =
  /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|Electron\/.*Headless/i;

export function classifyTraffic(signals: TrafficSignals): TrafficClass {
  const userAgent = (signals.userAgent ?? "").slice(0, 500);
  for (const [pattern, name] of AI_AGENTS) {
    if (pattern.test(userAgent)) return { type: "ai_agent", agent: name };
  }
  for (const [pattern, name] of CRAWLERS) {
    if (pattern.test(userAgent)) return { type: "crawler", agent: name };
  }
  if (signals.webdriver === true || HEADLESS.test(userAgent)) {
    return { type: "automated", agent: null };
  }
  if (/\b(bot|crawler|spider|scraper)\b/i.test(userAgent)) {
    return { type: "crawler", agent: null };
  }
  return { type: "human", agent: null };
}

export const TRAFFIC_TYPES: TrafficType[] = [
  "human",
  "ai_agent",
  "automated",
  "crawler",
];
