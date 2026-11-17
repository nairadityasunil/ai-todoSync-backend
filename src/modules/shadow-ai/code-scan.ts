import { matchPackage, type CatalogTool } from "./catalog.js";

/**
 * Finds AI use in code: SDK dependencies in manifests and keys that look like
 * AI provider keys. Pure: it is given file names and contents and returns
 * findings. A matched key is NEVER returned whole, only its first characters
 * and a short hash, so the scan result cannot leak the secret it found.
 */

import { createHash } from "node:crypto";

export interface CodeFile {
  path: string;
  content: string;
}

export interface PackageFinding {
  type: "package";
  path: string;
  line: number;
  pkg: string;
  tool: CatalogTool;
}

export interface KeyFinding {
  type: "key";
  path: string;
  line: number;
  provider: string;
  toolKey: string;
  /** First characters only, e.g. "sk-proj-ab…". */
  preview: string;
  /** Short hash so the same key found twice is one finding. */
  fingerprint: string;
}

export type CodeFinding = PackageFinding | KeyFinding;

const KEY_PATTERNS: Array<{ provider: string; toolKey: string; re: RegExp }> = [
  {
    provider: "Anthropic",
    toolKey: "anthropic_api",
    re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g,
  },
  {
    provider: "OpenAI",
    toolKey: "openai_api",
    re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  },
  { provider: "OpenAI", toolKey: "openai_api", re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  {
    provider: "Google AI",
    toolKey: "google_ai_api",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    provider: "Hugging Face",
    toolKey: "huggingface",
    re: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    provider: "Replicate",
    toolKey: "replicate",
    re: /\br8_[A-Za-z0-9]{30,}\b/g,
  },
  { provider: "Groq", toolKey: "groq", re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
  { provider: "xAI", toolKey: "grok", re: /\bxai-[A-Za-z0-9]{40,}\b/g },
  {
    provider: "Perplexity",
    toolKey: "perplexity",
    re: /\bpplx-[A-Za-z0-9]{32,}\b/g,
  },
];

const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.git|vendor|coverage)\//;
const MAX_FILE = 400_000;

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

function packagesOf(file: CodeFile): Array<{ pkg: string; line: number }> {
  const out: Array<{ pkg: string; line: number }> = [];
  const name = file.path.split("/").pop()?.toLowerCase() ?? "";
  const lines = file.content.split("\n");
  const push = (pkg: string, i: number) =>
    out.push({ pkg: pkg.toLowerCase(), line: i + 1 });
  if (name === "package.json") {
    try {
      const json = JSON.parse(file.content) as Record<
        string,
        Record<string, string> | undefined
      >;
      const names = new Set<string>();
      for (const k of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ])
        Object.keys(json[k] ?? {}).forEach((n) => names.add(n));
      for (const n of names) {
        const i = lines.findIndex((l) => l.includes(`"${n}"`));
        push(n, Math.max(0, i));
      }
    } catch {
      /* not valid JSON: nothing to read */
    }
  } else if (
    name === "requirements.txt" ||
    /^requirements.*\.txt$/.test(name)
  ) {
    lines.forEach((l, i) => {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*(?:[=<>!~[;].*)?$/.exec(
        l.split("#")[0] ?? "",
      );
      if (m) push(m[1], i);
    });
  } else if (name === "pyproject.toml" || name === "pipfile") {
    lines.forEach((l, i) => {
      const m = /^\s*"?([A-Za-z0-9_.-]+)"?\s*(?:[=<>!~[].*)?"?,?\s*$/.exec(l);
      if (m) push(m[1], i);
      for (const q of l.matchAll(
        /"([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:[=<>!~].*?)?"/g,
      ))
        push(q[1], i);
    });
  } else if (/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(name)) {
    lines.forEach((l, i) => {
      const js =
        /(?:from|require\()\s*['"]([^'"]+)['"]/.exec(l) ??
        /^\s*import\s+['"]([^'"]+)['"]/.exec(l);
      if (js) {
        const spec = js[1];
        push(
          spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0],
          i,
        );
      }
      const py = /^\s*(?:from|import)\s+([A-Za-z0-9_]+)/.exec(l);
      if (py && name.endsWith(".py")) push(py[1], i);
    });
  }
  return out;
}

export function scanCode(files: CodeFile[], maxFindings = 500): CodeFinding[] {
  const found: CodeFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (found.length >= maxFindings) break;
    if (
      !file?.path ||
      typeof file.content !== "string" ||
      SKIP_PATH.test(file.path) ||
      file.content.length > MAX_FILE
    )
      continue;
    for (const { pkg, line } of packagesOf(file)) {
      const tool = matchPackage(pkg);
      const key = `p:${file.path}:${pkg}`;
      if (tool && !seen.has(key)) {
        seen.add(key);
        found.push({ type: "package", path: file.path, line, pkg, tool });
      }
    }
    file.content.split("\n").forEach((text, i) => {
      for (const { provider, toolKey, re } of KEY_PATTERNS) {
        for (const m of text.matchAll(re)) {
          const fp = fingerprint(m[0]);
          const key = `k:${file.path}:${fp}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({
            type: "key",
            path: file.path,
            line: i + 1,
            provider,
            toolKey,
            preview: `${m[0].slice(0, 9)}…`,
            fingerprint: fp,
          });
        }
      }
    });
  }
  return found;
}
