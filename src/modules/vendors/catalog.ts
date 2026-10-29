/**
 * Known third parties, and how agents and webhook URLs map onto them. Pure,
 * so discovery can be unit tested. Unknown AI clients still become vendors
 * (named after their client); generic tools such as curl or a headless
 * browser are not third parties and map to nothing.
 */

export type VendorCategory =
  | "ai_model"
  | "ai_assistant"
  | "automation"
  | "observability"
  | "communication"
  | "developer_tool"
  | "other";

export interface CatalogVendor {
  key: string;
  name: string;
  category: VendorCategory;
  website: string;
  /** What it does for the workspace, for the sub-processor list. */
  purpose: string;
}

export const VENDOR_CATALOG: Record<string, CatalogVendor> = {
  openai: {
    key: "openai",
    name: "OpenAI",
    category: "ai_model",
    website: "https://openai.com",
    purpose: "AI model provider",
  },
  anthropic: {
    key: "anthropic",
    name: "Anthropic",
    category: "ai_model",
    website: "https://www.anthropic.com",
    purpose: "AI model provider",
  },
  google: {
    key: "google",
    name: "Google (Gemini)",
    category: "ai_model",
    website: "https://ai.google.dev",
    purpose: "AI model provider",
  },
  groq: {
    key: "groq",
    name: "Groq",
    category: "ai_model",
    website: "https://groq.com",
    purpose: "AI model inference",
  },
  mistral: {
    key: "mistral",
    name: "Mistral AI",
    category: "ai_model",
    website: "https://mistral.ai",
    purpose: "AI model provider",
  },
  perplexity: {
    key: "perplexity",
    name: "Perplexity",
    category: "ai_assistant",
    website: "https://www.perplexity.ai",
    purpose: "AI assistant",
  },
  cursor: {
    key: "cursor",
    name: "Cursor (Anysphere)",
    category: "ai_assistant",
    website: "https://cursor.com",
    purpose: "AI coding assistant",
  },
  github: {
    key: "github",
    name: "GitHub (Copilot)",
    category: "ai_assistant",
    website: "https://github.com",
    purpose: "AI coding assistant",
  },
  windsurf: {
    key: "windsurf",
    name: "Windsurf",
    category: "ai_assistant",
    website: "https://windsurf.com",
    purpose: "AI coding assistant",
  },
  langchain: {
    key: "langchain",
    name: "LangChain",
    category: "developer_tool",
    website: "https://www.langchain.com",
    purpose: "AI application framework",
  },
  llamaindex: {
    key: "llamaindex",
    name: "LlamaIndex",
    category: "developer_tool",
    website: "https://www.llamaindex.ai",
    purpose: "AI application framework",
  },
  crewai: {
    key: "crewai",
    name: "CrewAI",
    category: "developer_tool",
    website: "https://www.crewai.com",
    purpose: "AI agent framework",
  },
  zapier: {
    key: "zapier",
    name: "Zapier",
    category: "automation",
    website: "https://zapier.com",
    purpose: "Workflow automation",
  },
  n8n: {
    key: "n8n",
    name: "n8n",
    category: "automation",
    website: "https://n8n.io",
    purpose: "Workflow automation",
  },
  make: {
    key: "make",
    name: "Make",
    category: "automation",
    website: "https://www.make.com",
    purpose: "Workflow automation",
  },
  postman: {
    key: "postman",
    name: "Postman",
    category: "developer_tool",
    website: "https://www.postman.com",
    purpose: "API client",
  },
  slack: {
    key: "slack",
    name: "Slack",
    category: "communication",
    website: "https://slack.com",
    purpose: "Alert notifications",
  },
  microsoft: {
    key: "microsoft",
    name: "Microsoft Teams",
    category: "communication",
    website: "https://www.microsoft.com/microsoft-teams",
    purpose: "Alert notifications",
  },
  splunk: {
    key: "splunk",
    name: "Splunk",
    category: "observability",
    website: "https://www.splunk.com",
    purpose: "Security monitoring (SIEM)",
  },
  datadog: {
    key: "datadog",
    name: "Datadog",
    category: "observability",
    website: "https://www.datadoghq.com",
    purpose: "Security monitoring (SIEM)",
  },
  sumologic: {
    key: "sumologic",
    name: "Sumo Logic",
    category: "observability",
    website: "https://www.sumologic.com",
    purpose: "Security monitoring (SIEM)",
  },
  pagerduty: {
    key: "pagerduty",
    name: "PagerDuty",
    category: "observability",
    website: "https://www.pagerduty.com",
    purpose: "Incident alerting",
  },
};

/** AI provider ids used by project AI. */
const PROVIDERS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  groq: "groq",
  mistral: "mistral",
};

/** Client names (MCP clients, detected families) to vendors. */
const CLIENTS: Array<[RegExp, string]> = [
  [/^claude|anthropic/i, "anthropic"],
  [/chatgpt|openai/i, "openai"],
  [/cursor/i, "cursor"],
  [/copilot|vscode|visual studio code|github/i, "github"],
  [/windsurf|codeium/i, "windsurf"],
  [/gemini/i, "google"],
  [/perplexity/i, "perplexity"],
  [/langchain/i, "langchain"],
  [/llamaindex/i, "llamaindex"],
  [/crewai/i, "crewai"],
  [/zapier/i, "zapier"],
  [/^n8n/i, "n8n"],
  [/^make$/i, "make"],
  [/postman/i, "postman"],
];

/** Tools that are not third parties: the person's own scripts and browsers. */
const NOT_A_VENDOR =
  /^(curl|wget|node\.js|node-fetch|axios|got|python-requests|python-httpx|aiohttp|python urllib|go http client|okhttp|java http client|ruby http client|powershell|insomnia|headless chrome|playwright|puppeteer|phantomjs|selenium|browser-use|unidentified script|script with a browser user agent|ollama|mcp client)$/i;

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)slack\.com$/i, "slack"],
  [
    /(^|\.)office\.com$|(^|\.)webhook\.office\.com$|logic\.azure\.com$/i,
    "microsoft",
  ],
  [/(^|\.)splunkcloud\.com$|(^|\.)splunk\.com$/i, "splunk"],
  [/(^|\.)datadoghq\.(com|eu)$|(^|\.)ddog-gov\.com$/i, "datadog"],
  [/(^|\.)sumologic\.com$/i, "sumologic"],
  [/(^|\.)pagerduty\.com$/i, "pagerduty"],
  [/(^|\.)zapier\.com$/i, "zapier"],
  [/(^|\.)n8n\.cloud$/i, "n8n"],
  [/(^|\.)make\.com$|(^|\.)integromat\.com$/i, "make"],
];

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** A vendor to create for something the catalog does not know. */
export const unknownVendor = (
  name: string,
  category: VendorCategory,
): CatalogVendor => ({
  key: slug(name) || "unknown",
  name: name.slice(0, 80),
  category,
  website: "",
  purpose: "",
});

/** The third party behind an agent, or null for first-party tools and keys. */
export function vendorForAgent(agent: {
  kind: string;
  clientName?: string | null;
  fingerprint?: string | null;
}): CatalogVendor | null {
  const client = (agent.clientName ?? "").trim();
  switch (agent.kind) {
    case "ai_provider": {
      const id = (agent.fingerprint ?? "").replace(/^provider:/, "") || client;
      if (id === "ollama") return null; // self-hosted
      const key = PROVIDERS[id.toLowerCase()];
      return key ? VENDOR_CATALOG[key] : unknownVendor(id, "ai_model");
    }
    case "chatgpt":
      return VENDOR_CATALOG.openai;
    case "mcp_client":
    case "detected": {
      if (!client || NOT_A_VENDOR.test(client)) return null;
      const match = CLIENTS.find(([pattern]) => pattern.test(client));
      if (match) return VENDOR_CATALOG[match[1]];
      // An unknown MCP client is someone's AI app; an unknown script is not.
      return agent.kind === "mcp_client"
        ? unknownVendor(client, "ai_assistant")
        : null;
    }
    default:
      // API keys and companion devices are the workspace's own.
      return null;
  }
}

/** The third party behind a webhook destination, if it is a known service. */
export function vendorForUrl(rawUrl: string): CatalogVendor | null {
  try {
    const host = new URL(rawUrl).hostname;
    const match = HOSTS.find(([pattern]) => pattern.test(host));
    return match ? VENDOR_CATALOG[match[1]] : null;
  } catch {
    return null;
  }
}

/** Project AI provider ids that belong to a vendor (for spend). */
export const providerIdsFor = (vendorKey: string): string[] =>
  Object.entries(PROVIDERS)
    .filter(([, key]) => key === vendorKey)
    .map(([id]) => id);
