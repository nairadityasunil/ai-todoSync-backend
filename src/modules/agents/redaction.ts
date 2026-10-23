/**
 * Masks secrets and personal data before agent inputs are logged, shown to
 * approvers or sent to external AI providers.
 */

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|cookie|session)/i;

const PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "email", regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  // Provider-style keys: sk-..., pk_live_..., ghp_..., AKIA..., long hex/base64 tokens.
  {
    label: "secret",
    regex:
      /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  { label: "card", regex: /\b(?:\d[ -]?){13,19}\b/g },
];

// Phone-like runs: 9-15 digits with optional +, spaces, dots, dashes or
// brackets. ISO dates and plain ids are left alone.
const PHONE_CANDIDATE = /(?<![\w.])\+?[\d(][\d\s().-]{7,}\d(?![\w.])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function maskPhones(text: string): string {
  return text.replace(PHONE_CANDIDATE, (candidate) => {
    const digits = candidate.replace(/\D/g, "").length;
    if (digits < 9 || digits > 15 || ISO_DATE.test(candidate)) return candidate;
    return "[phone]";
  });
}

export function maskText(value: string): string {
  const masked = PATTERNS.reduce(
    (text, { label, regex }) => text.replace(regex, `[${label}]`),
    value,
  );
  return maskPhones(masked);
}

/** Deep copy with secret-named fields replaced and personal data masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    const masked = maskText(value);
    return masked.length > 2000 ? `${masked.slice(0, 2000)}…` : masked;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key.startsWith("_")) continue; // internal fields such as _confirmationToken
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? "[redacted]"
        : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return (redact(input) as Record<string, unknown>) ?? {};
}
