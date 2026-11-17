/**
 * Known AI tools and how to recognise them: by domain (network, proxy and DNS
 * logs, OAuth grants), by package name (dependency manifests and imports) and
 * by key shape (secret scanning). Pure data and functions, no I/O.
 *
 * The catalog says what a tool IS, not what its vendor promises. It carries no
 * claims about data retention or training, which change and belong in a review.
 */

export const TOOL_KINDS = [
  "assistant",
  "coding",
  "model_api",
  "image_video",
  "meeting",
  "writing",
  "search",
  "agent_platform",
  "local_runtime",
  "model_hub",
  "unknown",
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const KIND_LABELS: Record<ToolKind, string> = {
  assistant: "Chat assistant",
  coding: "Coding assistant",
  model_api: "Model API",
  image_video: "Image, video or audio",
  meeting: "Meeting notes",
  writing: "Writing",
  search: "AI search",
  agent_platform: "Agent platform",
  local_runtime: "Local model runtime",
  model_hub: "Model hub",
  unknown: "Unclassified",
};

export interface CatalogTool {
  key: string;
  name: string;
  vendor: string;
  kind: ToolKind;
  domains: string[];
  /** Host patterns that are not a fixed domain (cloud regions). */
  patterns?: RegExp[];
  /** npm and PyPI package names (lower case). */
  packages?: string[];
}

export const CATALOG: CatalogTool[] = [
  {
    key: "chatgpt",
    name: "ChatGPT",
    vendor: "OpenAI",
    kind: "assistant",
    domains: ["chatgpt.com", "chat.openai.com"],
  },
  {
    key: "openai_api",
    name: "OpenAI API",
    vendor: "OpenAI",
    kind: "model_api",
    domains: ["api.openai.com", "platform.openai.com", "openai.com"],
    packages: ["openai", "@openai/agents", "tiktoken"],
  },
  {
    key: "claude",
    name: "Claude",
    vendor: "Anthropic",
    kind: "assistant",
    domains: ["claude.ai"],
  },
  {
    key: "anthropic_api",
    name: "Anthropic API",
    vendor: "Anthropic",
    kind: "model_api",
    domains: ["api.anthropic.com", "console.anthropic.com", "anthropic.com"],
    packages: [
      "anthropic",
      "@anthropic-ai/sdk",
      "@anthropic-ai/claude-code",
      "claude-agent-sdk",
      "@anthropic-ai/claude-agent-sdk",
    ],
  },
  {
    key: "gemini",
    name: "Gemini",
    vendor: "Google",
    kind: "assistant",
    domains: ["gemini.google.com", "notebooklm.google.com"],
  },
  {
    key: "google_ai_api",
    name: "Google AI (Gemini API)",
    vendor: "Google",
    kind: "model_api",
    domains: ["aistudio.google.com", "generativelanguage.googleapis.com"],
    packages: [
      "google-generativeai",
      "@google/generative-ai",
      "@google/genai",
      "google-genai",
    ],
  },
  {
    key: "vertex_ai",
    name: "Google Vertex AI",
    vendor: "Google",
    kind: "model_api",
    domains: ["aiplatform.googleapis.com"],
    packages: [
      "google-cloud-aiplatform",
      "@google-cloud/vertexai",
      "@google-cloud/aiplatform",
      "vertexai",
    ],
  },
  {
    key: "azure_openai",
    name: "Azure OpenAI",
    vendor: "Microsoft",
    kind: "model_api",
    domains: ["openai.azure.com", "cognitiveservices.azure.com"],
    packages: [
      "@azure/openai",
      "azure-ai-inference",
      "@azure-rest/ai-inference",
    ],
  },
  {
    key: "aws_bedrock",
    name: "Amazon Bedrock",
    vendor: "Amazon",
    kind: "model_api",
    domains: [],
    patterns: [
      /^bedrock(-runtime|-agent|-agent-runtime)?(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/,
    ],
    packages: [
      "@aws-sdk/client-bedrock-runtime",
      "@aws-sdk/client-bedrock",
      "@aws-sdk/client-bedrock-agent-runtime",
      "langchain-aws",
    ],
  },
  {
    key: "sagemaker",
    name: "Amazon SageMaker",
    vendor: "Amazon",
    kind: "model_api",
    domains: [],
    patterns: [/^runtime\.sagemaker\.[a-z0-9-]+\.amazonaws\.com$/],
    packages: [
      "sagemaker",
      "@aws-sdk/client-sagemaker-runtime",
      "@aws-sdk/client-sagemaker",
    ],
  },
  {
    key: "copilot",
    name: "Microsoft Copilot",
    vendor: "Microsoft",
    kind: "assistant",
    domains: ["copilot.microsoft.com"],
  },
  {
    key: "github_copilot",
    name: "GitHub Copilot",
    vendor: "GitHub",
    kind: "coding",
    domains: ["githubcopilot.com", "copilot-proxy.githubusercontent.com"],
  },
  {
    key: "perplexity",
    name: "Perplexity",
    vendor: "Perplexity",
    kind: "search",
    domains: ["perplexity.ai", "api.perplexity.ai"],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    vendor: "DeepSeek",
    kind: "assistant",
    domains: ["deepseek.com", "chat.deepseek.com", "api.deepseek.com"],
  },
  {
    key: "grok",
    name: "Grok",
    vendor: "xAI",
    kind: "assistant",
    domains: ["grok.com", "x.ai", "api.x.ai"],
    packages: ["xai-sdk"],
  },
  {
    key: "mistral",
    name: "Mistral",
    vendor: "Mistral AI",
    kind: "assistant",
    domains: ["chat.mistral.ai", "api.mistral.ai", "mistral.ai"],
    packages: ["mistralai", "@mistralai/mistralai"],
  },
  {
    key: "meta_ai",
    name: "Meta AI",
    vendor: "Meta",
    kind: "assistant",
    domains: ["meta.ai"],
  },
  {
    key: "poe",
    name: "Poe",
    vendor: "Quora",
    kind: "assistant",
    domains: ["poe.com"],
  },
  {
    key: "character_ai",
    name: "Character.AI",
    vendor: "Character.AI",
    kind: "assistant",
    domains: ["character.ai"],
  },
  {
    key: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    kind: "coding",
    domains: ["cursor.com", "cursor.sh", "api2.cursor.sh"],
  },
  {
    key: "windsurf",
    name: "Windsurf",
    vendor: "Windsurf",
    kind: "coding",
    domains: ["windsurf.com", "codeium.com"],
  },
  {
    key: "replit",
    name: "Replit",
    vendor: "Replit",
    kind: "coding",
    domains: ["replit.com"],
  },
  {
    key: "v0",
    name: "v0",
    vendor: "Vercel",
    kind: "coding",
    domains: ["v0.dev", "v0.app"],
  },
  {
    key: "bolt",
    name: "Bolt",
    vendor: "StackBlitz",
    kind: "coding",
    domains: ["bolt.new"],
  },
  {
    key: "lovable",
    name: "Lovable",
    vendor: "Lovable",
    kind: "coding",
    domains: ["lovable.dev", "lovable.app"],
  },
  {
    key: "tabnine",
    name: "Tabnine",
    vendor: "Tabnine",
    kind: "coding",
    domains: ["tabnine.com"],
  },
  {
    key: "midjourney",
    name: "Midjourney",
    vendor: "Midjourney",
    kind: "image_video",
    domains: ["midjourney.com"],
  },
  {
    key: "stability",
    name: "Stability AI",
    vendor: "Stability AI",
    kind: "image_video",
    domains: ["stability.ai", "api.stability.ai"],
  },
  {
    key: "runway",
    name: "Runway",
    vendor: "Runway",
    kind: "image_video",
    domains: ["runwayml.com"],
  },
  {
    key: "pika",
    name: "Pika",
    vendor: "Pika",
    kind: "image_video",
    domains: ["pika.art"],
  },
  {
    key: "leonardo",
    name: "Leonardo.Ai",
    vendor: "Leonardo.Ai",
    kind: "image_video",
    domains: ["leonardo.ai"],
  },
  {
    key: "ideogram",
    name: "Ideogram",
    vendor: "Ideogram",
    kind: "image_video",
    domains: ["ideogram.ai"],
  },
  {
    key: "suno",
    name: "Suno",
    vendor: "Suno",
    kind: "image_video",
    domains: ["suno.com"],
  },
  {
    key: "elevenlabs",
    name: "ElevenLabs",
    vendor: "ElevenLabs",
    kind: "image_video",
    domains: ["elevenlabs.io", "api.elevenlabs.io"],
    packages: ["elevenlabs", "@elevenlabs/elevenlabs-js"],
  },
  {
    key: "heygen",
    name: "HeyGen",
    vendor: "HeyGen",
    kind: "image_video",
    domains: ["heygen.com"],
  },
  {
    key: "synthesia",
    name: "Synthesia",
    vendor: "Synthesia",
    kind: "image_video",
    domains: ["synthesia.io"],
  },
  {
    key: "otter",
    name: "Otter.ai",
    vendor: "Otter.ai",
    kind: "meeting",
    domains: ["otter.ai"],
  },
  {
    key: "fireflies",
    name: "Fireflies.ai",
    vendor: "Fireflies.ai",
    kind: "meeting",
    domains: ["fireflies.ai"],
  },
  {
    key: "fathom",
    name: "Fathom",
    vendor: "Fathom",
    kind: "meeting",
    domains: ["fathom.video"],
  },
  {
    key: "read_ai",
    name: "Read AI",
    vendor: "Read AI",
    kind: "meeting",
    domains: ["read.ai"],
  },
  {
    key: "grammarly",
    name: "Grammarly",
    vendor: "Grammarly",
    kind: "writing",
    domains: ["grammarly.com"],
  },
  {
    key: "jasper",
    name: "Jasper",
    vendor: "Jasper",
    kind: "writing",
    domains: ["jasper.ai"],
  },
  {
    key: "copy_ai",
    name: "Copy.ai",
    vendor: "Copy.ai",
    kind: "writing",
    domains: ["copy.ai"],
  },
  {
    key: "writesonic",
    name: "Writesonic",
    vendor: "Writesonic",
    kind: "writing",
    domains: ["writesonic.com"],
  },
  {
    key: "quillbot",
    name: "QuillBot",
    vendor: "QuillBot",
    kind: "writing",
    domains: ["quillbot.com"],
  },
  {
    key: "gamma",
    name: "Gamma",
    vendor: "Gamma",
    kind: "writing",
    domains: ["gamma.app"],
  },
  {
    key: "you_com",
    name: "You.com",
    vendor: "You.com",
    kind: "search",
    domains: ["you.com"],
  },
  {
    key: "phind",
    name: "Phind",
    vendor: "Phind",
    kind: "search",
    domains: ["phind.com"],
  },
  {
    key: "huggingface",
    name: "Hugging Face",
    vendor: "Hugging Face",
    kind: "model_hub",
    domains: ["huggingface.co", "hf.co"],
    packages: [
      "huggingface-hub",
      "huggingface_hub",
      "transformers",
      "@huggingface/inference",
      "@huggingface/transformers",
      "sentence-transformers",
      "diffusers",
    ],
  },
  {
    key: "replicate",
    name: "Replicate",
    vendor: "Replicate",
    kind: "model_hub",
    domains: ["replicate.com", "api.replicate.com"],
    packages: ["replicate"],
  },
  {
    key: "together",
    name: "Together AI",
    vendor: "Together AI",
    kind: "model_api",
    domains: ["together.ai", "api.together.xyz", "api.together.ai"],
    packages: ["together", "together-ai"],
  },
  {
    key: "groq",
    name: "Groq",
    vendor: "Groq",
    kind: "model_api",
    domains: ["groq.com", "api.groq.com"],
    packages: ["groq", "groq-sdk"],
  },
  {
    key: "cohere",
    name: "Cohere",
    vendor: "Cohere",
    kind: "model_api",
    domains: ["cohere.com", "cohere.ai", "api.cohere.com", "api.cohere.ai"],
    packages: ["cohere", "cohere-ai"],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    vendor: "OpenRouter",
    kind: "model_api",
    domains: ["openrouter.ai"],
    packages: ["@openrouter/ai-sdk-provider", "@openrouter/sdk"],
  },
  {
    key: "fireworks",
    name: "Fireworks AI",
    vendor: "Fireworks AI",
    kind: "model_api",
    domains: ["fireworks.ai", "api.fireworks.ai"],
    packages: ["fireworks-ai"],
  },
  {
    key: "ollama",
    name: "Ollama",
    vendor: "Ollama",
    kind: "local_runtime",
    domains: ["ollama.com", "ollama.ai"],
    packages: ["ollama"],
  },
  {
    key: "lm_studio",
    name: "LM Studio",
    vendor: "LM Studio",
    kind: "local_runtime",
    domains: ["lmstudio.ai"],
    packages: ["@lmstudio/sdk", "lmstudio"],
  },
  {
    key: "manus",
    name: "Manus",
    vendor: "Manus",
    kind: "agent_platform",
    domains: ["manus.im"],
  },
  {
    key: "lindy",
    name: "Lindy",
    vendor: "Lindy",
    kind: "agent_platform",
    domains: ["lindy.ai"],
  },
  // Frameworks that call a model on the developer's behalf.
  {
    key: "langchain",
    name: "LangChain",
    vendor: "LangChain",
    kind: "agent_platform",
    domains: [
      "langchain.com",
      "smith.langchain.com",
      "api.smith.langchain.com",
    ],
    packages: [
      "langchain",
      "langchain-core",
      "langchain-community",
      "langchain-openai",
      "langchain-anthropic",
      "langgraph",
      "@langchain/core",
      "@langchain/openai",
      "@langchain/anthropic",
      "@langchain/langgraph",
      "langsmith",
    ],
  },
  {
    key: "llamaindex",
    name: "LlamaIndex",
    vendor: "LlamaIndex",
    kind: "agent_platform",
    domains: ["llamaindex.ai", "cloud.llamaindex.ai"],
    packages: ["llama-index", "llama_index", "llamaindex", "llama-index-core"],
  },
  {
    key: "litellm",
    name: "LiteLLM",
    vendor: "BerriAI",
    kind: "model_api",
    domains: [],
    packages: ["litellm"],
  },
  {
    key: "vercel_ai",
    name: "Vercel AI SDK",
    vendor: "Vercel",
    kind: "model_api",
    domains: ["ai-gateway.vercel.sh"],
    packages: [
      "ai",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@ai-sdk/react",
    ],
  },
  {
    key: "crewai",
    name: "CrewAI",
    vendor: "CrewAI",
    kind: "agent_platform",
    domains: [],
    packages: ["crewai"],
  },
  {
    key: "autogen",
    name: "AutoGen",
    vendor: "Microsoft",
    kind: "agent_platform",
    domains: [],
    packages: ["pyautogen", "autogen-agentchat", "autogen"],
  },
  {
    key: "pinecone",
    name: "Pinecone",
    vendor: "Pinecone",
    kind: "model_hub",
    domains: ["pinecone.io"],
    packages: ["pinecone", "pinecone-client", "@pinecone-database/pinecone"],
  },
];

export const CATALOG_BY_KEY = new Map(CATALOG.map((t) => [t.key, t]));

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** A bare, lower-case hostname from a hostname, URL or "host:port". Null when it is not one. */
export function hostnameOf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (!value || value.length > 300) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      value,
    )
  )
    return null;
  return value.startsWith("www.") ? value.slice(4) : value;
}

// Longest domain first, so "chat.openai.com" is ChatGPT while "api.openai.com" is the API.
const DOMAIN_INDEX: Array<{ domain: string; tool: CatalogTool }> =
  CATALOG.flatMap((tool) =>
    tool.domains.map((domain) => ({ domain, tool })),
  ).sort((a, b) => b.domain.length - a.domain.length);

export function matchHost(host: string): CatalogTool | null {
  for (const { domain, tool } of DOMAIN_INDEX)
    if (host === domain || host.endsWith(`.${domain}`)) return tool;
  for (const tool of CATALOG)
    if (tool.patterns?.some((p) => p.test(host))) return tool;
  return null;
}

const AI_WORDS =
  /(^|[.-])(gpt|llm|copilot|chatbot|genai|openai|aiassistant|ai-assistant|prompt|agentic)([.-]|$)|(^|\.)ai\.[a-z0-9-]+\.[a-z]+$/;

/** A host that is not in the catalog but looks like AI from its name. Low confidence, so it only asks for a decision. */
export const looksLikeAi = (host: string): boolean =>
  AI_WORDS.test(host) ||
  /\b(gpt|llm|copilot)\b/.test(host.replace(/[.-]/g, " "));

/** Free text such as an OAuth app or cloud service name to a catalog tool. */
export function matchName(name: string): CatalogTool | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  for (const tool of CATALOG) {
    if (
      tool.name.toLowerCase() === n ||
      tool.key === n.replace(/[^a-z0-9]+/g, "_")
    )
      return tool;
  }
  for (const tool of CATALOG) {
    const t = tool.name.toLowerCase();
    if (t.length >= 5 && n.includes(t)) return tool;
  }
  return null;
}

/** A package name from a manifest or an import to a catalog tool. */
export function matchPackage(pkg: string): CatalogTool | null {
  const p = pkg.trim().toLowerCase();
  for (const tool of CATALOG) if (tool.packages?.includes(p)) return tool;
  return null;
}

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
