/**
 * Shadow AI detection: tells a person in a browser apart from a script or
 * automated browser that uses the person's own login. Pure, so it can be unit
 * tested; the auth middleware registers what it finds as a "detected" agent.
 */

export interface ClientSignals {
  userAgent?: string | null;
  origin?: string | null;
  referer?: string | null;
  secFetchMode?: string | null;
  secFetchSite?: string | null;
}

export type DetectionSignal =
  | "automation_library"
  | "headless_browser"
  | "no_user_agent"
  | "not_a_browser"
  | "browser_without_fetch_metadata";

export interface Detection {
  /** Display name for the client family, e.g. "python-requests". */
  family: string;
  signals: DetectionSignal[];
}

/** Known HTTP clients, SDKs and browser automation, in match order. */
const KNOWN_CLIENTS: Array<{
  pattern: RegExp;
  family: string;
  headless?: boolean;
}> = [
  { pattern: /HeadlessChrome/i, family: "Headless Chrome", headless: true },
  { pattern: /Playwright/i, family: "Playwright", headless: true },
  { pattern: /Puppeteer/i, family: "Puppeteer", headless: true },
  { pattern: /PhantomJS/i, family: "PhantomJS", headless: true },
  { pattern: /Selenium|webdriver/i, family: "Selenium", headless: true },
  { pattern: /LangChain/i, family: "LangChain" },
  { pattern: /LlamaIndex/i, family: "LlamaIndex" },
  { pattern: /CrewAI/i, family: "CrewAI" },
  { pattern: /AutoGen/i, family: "AutoGen" },
  { pattern: /browser-use/i, family: "browser-use", headless: true },
  { pattern: /^OpenAI\//i, family: "OpenAI SDK" },
  { pattern: /^Anthropic\//i, family: "Anthropic SDK" },
  { pattern: /python-requests/i, family: "python-requests" },
  { pattern: /python-httpx/i, family: "python-httpx" },
  { pattern: /aiohttp/i, family: "aiohttp" },
  { pattern: /Python-urllib/i, family: "Python urllib" },
  { pattern: /^axios\//i, family: "axios" },
  { pattern: /node-fetch/i, family: "node-fetch" },
  { pattern: /^undici|^node$/i, family: "Node.js" },
  { pattern: /^got\b/i, family: "got" },
  { pattern: /^curl\//i, family: "curl" },
  { pattern: /^Wget\//i, family: "Wget" },
  { pattern: /Go-http-client/i, family: "Go HTTP client" },
  { pattern: /okhttp/i, family: "OkHttp" },
  { pattern: /^Java\/|Apache-HttpClient/i, family: "Java HTTP client" },
  { pattern: /^Ruby|Faraday/i, family: "Ruby HTTP client" },
  { pattern: /PowerShell/i, family: "PowerShell" },
  { pattern: /PostmanRuntime/i, family: "Postman" },
  { pattern: /insomnia/i, family: "Insomnia" },
  { pattern: /^Zapier/i, family: "Zapier" },
  { pattern: /^n8n/i, family: "n8n" },
  { pattern: /^Make\//i, family: "Make" },
];

const clean = (value?: string | null): string => (value ?? "").trim();

/** First product token of a user agent: "MyBot/1.2 (+x)" -> "MyBot". */
const productToken = (userAgent: string): string =>
  userAgent.split(/[\s/;(]/)[0]?.slice(0, 60) || "Unknown client";

/**
 * Returns what kind of automated client sent a request, or null for a person
 * in a browser. A browser sends fetch metadata (Sec-Fetch-*) or an Origin or
 * Referer with every portal call; scripts send none of them.
 */
export function classifyClient(input: ClientSignals): Detection | null {
  const userAgent = clean(input.userAgent);
  const browserMetadata = Boolean(
    clean(input.secFetchMode) ||
    clean(input.secFetchSite) ||
    clean(input.origin) ||
    clean(input.referer),
  );

  if (!userAgent) {
    return { family: "Unidentified script", signals: ["no_user_agent"] };
  }

  const known = KNOWN_CLIENTS.find((client) => client.pattern.test(userAgent));
  if (known) {
    return {
      family: known.family,
      signals: [known.headless ? "headless_browser" : "automation_library"],
    };
  }

  const looksLikeBrowser = /^Mozilla\/5\.0/.test(userAgent);
  if (!looksLikeBrowser) {
    return { family: productToken(userAgent), signals: ["not_a_browser"] };
  }
  if (!browserMetadata) {
    // A browser user agent without anything a browser sends with fetch: a
    // script copying a browser's user agent.
    return {
      family: "Script with a browser user agent",
      signals: ["browser_without_fetch_metadata"],
    };
  }
  return null;
}

export const SIGNAL_LABELS: Record<DetectionSignal, string> = {
  automation_library: "Uses an HTTP library or AI framework",
  headless_browser: "Automated (headless) browser",
  no_user_agent: "Sends no user agent",
  not_a_browser: "Client is not a web browser",
  browser_without_fetch_metadata:
    "Claims to be a browser but sends none of a browser's request headers",
};

/** Stable fingerprint for one client family of one person. */
export const detectionFingerprint = (family: string): string =>
  `detected:${family.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
