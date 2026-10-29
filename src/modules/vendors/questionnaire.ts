/**
 * Third-party due-diligence questionnaire, written for AI vendors but
 * usable for any. Answers that count as controls lower residual risk
 * (see risk.ts); each question cites the framework it supports.
 */

export type QuestionType = "yes_no" | "select" | "text" | "date";

export interface Question {
  id: string;
  section: "Data use" | "Security" | "Contract" | "Operations";
  text: string;
  type: QuestionType;
  options?: Array<{ value: string; label: string }>;
  required: boolean;
  /** Help shown under the question. */
  hint?: string;
  framework: string;
}

export const QUESTIONNAIRE_VERSION = 1;

export const QUESTIONS: Question[] = [
  {
    id: "trains_on_data",
    section: "Data use",
    text: "Does the vendor use your data to train or improve its models?",
    type: "select",
    options: [
      { value: "no", label: "No, contractually excluded" },
      { value: "opt_out", label: "Only unless we opt out (and we have)" },
      { value: "yes", label: "Yes" },
      { value: "unknown", label: "Unknown" },
    ],
    required: true,
    framework: "EU AI Act Art. 26; GDPR Art. 28(3)",
  },
  {
    id: "retention",
    section: "Data use",
    text: "How long does the vendor keep the data it receives?",
    type: "select",
    options: [
      { value: "zero", label: "Not stored (zero retention)" },
      { value: "30_days", label: "Up to 30 days" },
      { value: "longer", label: "Longer than 30 days" },
      { value: "unknown", label: "Unknown" },
    ],
    required: true,
    framework: "GDPR Art. 5(1)(e); ISO/IEC 27001 A.5.34",
  },
  {
    id: "data_location",
    section: "Data use",
    text: "Where is the data processed and stored?",
    type: "text",
    required: true,
    hint: "e.g. EU (Ireland), United States",
    framework: "GDPR Chapter V",
  },
  {
    id: "subprocessors_listed",
    section: "Data use",
    text: "Does the vendor publish its own sub-processors and notify changes?",
    type: "yes_no",
    required: false,
    framework: "GDPR Art. 28(2)",
  },
  {
    id: "certifications",
    section: "Security",
    text: "Which current certifications or audit reports does it hold?",
    type: "select",
    options: [
      { value: "soc2_iso", label: "SOC 2 Type II and ISO/IEC 27001" },
      { value: "soc2", label: "SOC 2 Type II" },
      { value: "iso27001", label: "ISO/IEC 27001" },
      { value: "none", label: "None" },
    ],
    required: true,
    hint: "Upload the report under Evidence with its expiry date.",
    framework: "ISO/IEC 27001 A.5.19-A.5.22",
  },
  {
    id: "encryption",
    section: "Security",
    text: "Is data encrypted in transit and at rest?",
    type: "yes_no",
    required: true,
    framework: "ISO/IEC 27001 A.8.24",
  },
  {
    id: "sso_mfa",
    section: "Security",
    text: "Does access to the vendor's console require SSO or MFA?",
    type: "yes_no",
    required: false,
    framework: "ISO/IEC 27001 A.5.17",
  },
  {
    id: "incident_notice",
    section: "Operations",
    text: "How quickly does the vendor notify security incidents?",
    type: "select",
    options: [
      { value: "72h", label: "Within 72 hours" },
      { value: "later", label: "Later, or not committed" },
      { value: "unknown", label: "Unknown" },
    ],
    required: true,
    framework: "GDPR Art. 33; DORA Art. 19",
  },
  {
    id: "exit_plan",
    section: "Operations",
    text: "Could you switch away from this vendor within 30 days if needed?",
    type: "yes_no",
    required: false,
    framework: "DORA Art. 28(8); NIST CSF GV.SC-10",
  },
  {
    id: "dpa_signed",
    section: "Contract",
    text: "Is a data processing agreement (DPA) signed?",
    type: "yes_no",
    required: true,
    hint: "Set its expiry under Contract and upload it under Evidence.",
    framework: "GDPR Art. 28(3)",
  },
];

export type Answers = Record<string, string>;

/** Keeps only known questions with valid values. */
export function sanitizeAnswers(input: unknown): Answers {
  if (!input || typeof input !== "object") return {};
  const out: Answers = {};
  for (const question of QUESTIONS) {
    const raw = (input as Record<string, unknown>)[question.id];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw).trim().slice(0, 500);
    if (question.type === "yes_no" && !["yes", "no"].includes(value)) continue;
    if (
      question.type === "select" &&
      !question.options?.some((option) => option.value === value)
    )
      continue;
    if (question.type === "date" && Number.isNaN(Date.parse(value))) continue;
    out[question.id] = value;
  }
  return out;
}

/** Required questions still unanswered. */
export function missingAnswers(answers: Answers): string[] {
  return QUESTIONS.filter((q) => q.required && !answers[q.id]).map((q) => q.id);
}
