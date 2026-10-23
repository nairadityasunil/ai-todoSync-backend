import { maskText } from "./redaction.js";
import { FRAMEWORKS } from "./risk.js";

/**
 * Static checks run on a prompt version before it reaches production
 * traffic (canary start) and on demand from the prompt editor.
 */

export type PromptCheckSeverity = "high" | "medium" | "low";

export interface PromptFinding {
  code: string;
  severity: PromptCheckSeverity;
  message: string;
  framework: string;
}

export interface PromptCheckInput {
  body?: string | null;
  messages?: Array<{ role: string; content: string }> | null;
  parameters?: { maxTokens?: number | null } | null;
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?|rules)/i,
  /disregard (the |your )?(system|previous|prior) (prompt|instructions)/i,
  /(reveal|print|show|repeat) (the |your )?(system prompt|hidden instructions)/i,
  /you are no longer bound by/i,
  /developer mode|jailbreak|\bDAN\b/,
];

const ACTION_PATTERN =
  /\b(delete|drop|remove all|wipe|transfer|send (money|payment)|grant (admin|access))\b/i;

export function checkPrompt(input: PromptCheckInput): PromptFinding[] {
  const parts = [
    input.body ?? "",
    ...(input.messages ?? []).map((message) => message.content ?? ""),
  ];
  const text = parts.join("\n");
  const findings: PromptFinding[] = [];

  const masked = maskText(text);
  if (/\[secret\]/.test(masked) && !/\[secret\]/.test(text)) {
    findings.push({
      code: "embedded_secret",
      severity: "high",
      message:
        "The prompt contains what looks like an API key or token. Move secrets out of prompts.",
      framework: FRAMEWORKS.OWASP_SENSITIVE_DATA,
    });
  }
  const personal = ["email", "phone", "card"].filter(
    (label) => masked.includes(`[${label}]`) && !text.includes(`[${label}]`),
  );
  if (personal.length > 0) {
    findings.push({
      code: "personal_data",
      severity: "medium",
      message: `The prompt contains personal data (${personal.join(", ")}). Use variables instead of real values.`,
      framework: FRAMEWORKS.OWASP_SENSITIVE_DATA,
    });
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    findings.push({
      code: "injection_phrase",
      severity: "high",
      message: "The prompt contains a known prompt-injection phrase.",
      framework: "OWASP LLM01:2025 Prompt Injection",
    });
  }
  if (
    /\{\{\s*[\w.]+\s*\}\}/.test(text) &&
    !(input.messages ?? []).some((m) => m.role === "system")
  ) {
    findings.push({
      code: "unfenced_input",
      severity: "low",
      message:
        "User variables are inserted without a system message that sets boundaries for them.",
      framework: "OWASP LLM01:2025 Prompt Injection",
    });
  }
  if (ACTION_PATTERN.test(text)) {
    findings.push({
      code: "high_impact_instruction",
      severity: "medium",
      message:
        "The prompt asks the model to take high-impact actions. Keep a person in the loop.",
      framework: FRAMEWORKS.OWASP_EXCESSIVE_AGENCY,
    });
  }
  if (input.parameters && !input.parameters.maxTokens) {
    findings.push({
      code: "no_output_limit",
      severity: "low",
      message: "No maximum output length is set.",
      framework: FRAMEWORKS.OWASP_UNBOUNDED,
    });
  }
  return findings;
}

export const hasBlockingFindings = (findings: PromptFinding[]): boolean =>
  findings.some((finding) => finding.severity === "high");
