/**
 * Reference data for AI governance: lifecycle stages, the risk questionnaire,
 * the EU AI Act applicability assessment, the AI risk library and the
 * evaluation metrics. Pure data and pure functions, no I/O.
 */

export const STAGES = [
  "proposed",
  "assessment",
  "development",
  "validation",
  "production",
  "retired",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  proposed: "Proposed",
  assessment: "Risk assessment",
  development: "Development",
  validation: "Validation",
  production: "Production",
  retired: "Retired",
};

export const TIERS = ["low", "medium", "high", "prohibited"] as const;
export type Tier = (typeof TIERS)[number];

export const AI_TYPES = [
  "generative",
  "predictive",
  "agentic",
  "rules",
] as const;
export type AiType = (typeof AI_TYPES)[number];

export const APPROVER_ROLES = [
  "owner",
  "risk",
  "legal",
  "ethics",
  "security",
] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

export const ROLE_LABELS: Record<ApproverRole, string> = {
  owner: "Use case owner",
  risk: "Risk",
  legal: "Legal and compliance",
  ethics: "AI ethics",
  security: "Security",
};

/** The two gates that need sign-off, and who signs at each tier. */
export type Gate = "development" | "production";
export const GATES: Gate[] = ["development", "production"];

export function requiredApprovals(
  gate: Gate,
  tier: Tier | null,
  extraHighRoles: ApproverRole[] = [],
): ApproverRole[] {
  if (!tier || tier === "prohibited") return [];
  if (gate === "development")
    return tier === "high" ? ["owner", "risk"] : ["owner"];
  if (tier === "low") return ["owner"];
  if (tier === "medium") return ["owner", "risk"];
  return Array.from(
    new Set<ApproverRole>([
      "owner",
      "risk",
      "legal",
      "ethics",
      ...extraHighRoles,
    ]),
  );
}

export const DEFAULT_REVIEW_DAYS: Record<
  Exclude<Tier, "prohibited">,
  number
> = { low: 365, medium: 180, high: 90 };

// ---------------------------------------------------------------------------
// Risk questionnaire (internal risk tier)
// ---------------------------------------------------------------------------

export interface QuestionOption {
  value: string;
  label: string;
  points: number;
}
export interface RiskQuestion {
  id: string;
  text: string;
  help?: string;
  options: QuestionOption[];
}

export const RISK_QUESTIONS: RiskQuestion[] = [
  {
    id: "impact",
    text: "What happens when the AI gets it wrong?",
    options: [
      { value: "minor", label: "A minor inconvenience", points: 0 },
      {
        value: "costly",
        label: "It costs money or causes embarrassment",
        points: 2,
      },
      {
        value: "harm",
        label: "It can harm someone's rights, money, health or safety",
        points: 4,
      },
    ],
  },
  {
    id: "autonomy",
    text: "Who acts on its output?",
    options: [
      {
        value: "human_every",
        label: "A person reviews every output first",
        points: 0,
      },
      { value: "human_sample", label: "People check samples", points: 1 },
      { value: "autonomous", label: "It acts on its own", points: 3 },
    ],
  },
  {
    id: "decisions_about_people",
    text: "Does it make or support decisions about people (customers, staff, applicants)?",
    options: [
      { value: "no", label: "No", points: 0 },
      { value: "yes", label: "Yes", points: 3 },
    ],
  },
  {
    id: "data",
    text: "What data does it use?",
    options: [
      { value: "public", label: "Public data or none", points: 0 },
      { value: "internal", label: "Internal business data", points: 1 },
      { value: "personal", label: "Personal data", points: 2 },
      {
        value: "sensitive",
        label:
          "Sensitive personal data (health, biometrics, finances, children)",
        points: 3,
      },
    ],
  },
  {
    id: "scale",
    text: "How many people use it or are affected by it?",
    options: [
      { value: "small", label: "Fewer than 100", points: 0 },
      { value: "medium", label: "100 to 10,000", points: 1 },
      { value: "large", label: "More than 10,000", points: 2 },
    ],
  },
  {
    id: "audience",
    text: "Who sees its output?",
    options: [
      { value: "internal", label: "Only our staff", points: 0 },
      { value: "external", label: "Customers or the public", points: 1 },
    ],
  },
  {
    id: "third_party",
    text: "Is it built on a third-party model or service?",
    options: [
      { value: "no", label: "No, we built it", points: 0 },
      { value: "yes", label: "Yes", points: 1 },
    ],
  },
  {
    id: "reversibility",
    text: "Can a wrong outcome be undone?",
    options: [
      { value: "easy", label: "Easily", points: 0 },
      { value: "effort", label: "With effort", points: 1 },
      { value: "no", label: "No", points: 2 },
    ],
  },
];

export const MAX_RISK_POINTS = RISK_QUESTIONS.reduce(
  (sum, q) => sum + Math.max(...q.options.map((o) => o.points)),
  0,
);

export function sanitizeRiskAnswers(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const q of RISK_QUESTIONS) {
    const value = (raw as Record<string, unknown>)[q.id];
    if (typeof value === "string" && q.options.some((o) => o.value === value))
      out[q.id] = value;
  }
  return out;
}

export const missingRiskAnswers = (answers: Record<string, string>): string[] =>
  RISK_QUESTIONS.filter((q) => !answers[q.id]).map((q) => q.id);

// ---------------------------------------------------------------------------
// EU AI Act applicability (Regulation (EU) 2024/1689)
// ---------------------------------------------------------------------------

export interface EuQuestion {
  id: string;
  group:
    | "scope"
    | "prohibited"
    | "high_risk"
    | "exception"
    | "transparency"
    | "role";
  text: string;
  kind: "boolean" | "choice";
  options?: Array<{ value: string; label: string }>;
}

export const EU_HIGH_RISK_AREAS: Array<{ value: string; label: string }> = [
  { value: "none", label: "None of these" },
  {
    value: "biometrics",
    label:
      "Biometrics: remote identification, categorisation or emotion recognition",
  },
  {
    value: "critical_infrastructure",
    label:
      "Safety of critical infrastructure (traffic, water, gas, heating, electricity, digital)",
  },
  {
    value: "education",
    label: "Education: admission, grading, steering learning, proctoring",
  },
  {
    value: "employment",
    label:
      "Employment: hiring, promotion, termination, task allocation, monitoring staff",
  },
  {
    value: "essential_services",
    label:
      "Essential services: public benefits, credit scoring, life or health insurance pricing, emergency dispatch",
  },
  { value: "law_enforcement", label: "Law enforcement" },
  { value: "migration", label: "Migration, asylum and border control" },
  {
    value: "justice",
    label: "Justice and democratic processes (courts, elections)",
  },
];

export const EU_QUESTIONS: EuQuestion[] = [
  {
    id: "in_eu",
    group: "scope",
    kind: "boolean",
    text: "Is it offered in the EU, or are its outputs used in the EU?",
  },
  {
    id: "p_manipulation",
    group: "prohibited",
    kind: "boolean",
    text: "Does it use manipulative or deceptive techniques that distort people's behaviour and can cause significant harm?",
  },
  {
    id: "p_vulnerability",
    group: "prohibited",
    kind: "boolean",
    text: "Does it exploit vulnerabilities due to age, disability or social or economic situation?",
  },
  {
    id: "p_social_scoring",
    group: "prohibited",
    kind: "boolean",
    text: "Does it score people on social behaviour or personality in a way that leads to unfair treatment?",
  },
  {
    id: "p_predictive_policing",
    group: "prohibited",
    kind: "boolean",
    text: "Does it predict that someone will commit a crime based only on profiling or personality traits?",
  },
  {
    id: "p_face_scraping",
    group: "prohibited",
    kind: "boolean",
    text: "Does it build facial recognition databases by scraping images from the internet or CCTV?",
  },
  {
    id: "p_emotion_work_school",
    group: "prohibited",
    kind: "boolean",
    text: "Does it infer emotions of people at work or in education (other than for medical or safety reasons)?",
  },
  {
    id: "p_biometric_sensitive",
    group: "prohibited",
    kind: "boolean",
    text: "Does it use biometrics to infer race, political opinions, union membership, religion, sex life or orientation?",
  },
  {
    id: "p_realtime_rbi",
    group: "prohibited",
    kind: "boolean",
    text: "Does it identify people remotely and in real time in public spaces for law enforcement?",
  },
  {
    id: "high_risk_area",
    group: "high_risk",
    kind: "choice",
    options: EU_HIGH_RISK_AREAS,
    text: "Is it used in one of these areas (Annex III)?",
  },
  {
    id: "safety_component",
    group: "high_risk",
    kind: "boolean",
    text: "Is it a safety component of a regulated product (machinery, toys, medical devices, vehicles, lifts...)?",
  },
  {
    id: "profiling",
    group: "exception",
    kind: "boolean",
    text: "Does it profile people (evaluate personal aspects such as work performance, economic situation, health, behaviour)?",
  },
  {
    id: "narrow_task",
    group: "exception",
    kind: "boolean",
    text: "Does it only do a narrow procedural or preparatory task, or improve a result a person already produced, without replacing human judgement?",
  },
  {
    id: "t_interacts",
    group: "transparency",
    kind: "boolean",
    text: "Do people talk to it directly (a chatbot or voice assistant)?",
  },
  {
    id: "t_synthetic",
    group: "transparency",
    kind: "boolean",
    text: "Does it generate text, images, audio or video?",
  },
  {
    id: "t_deepfake",
    group: "transparency",
    kind: "boolean",
    text: "Does it create realistic images, audio or video of real people, places or events?",
  },
  {
    id: "t_emotion_biometric",
    group: "transparency",
    kind: "boolean",
    text: "Does it recognise emotions or categorise people by biometrics (where allowed)?",
  },
  {
    id: "role",
    group: "role",
    kind: "choice",
    text: "What is your role for this system?",
    options: [
      {
        value: "provider",
        label:
          "Provider: we develop it or have it developed and put it on the market under our name",
      },
      {
        value: "deployer",
        label: "Deployer: we use a system someone else provides",
      },
    ],
  },
];

export function sanitizeEuAnswers(
  raw: unknown,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const q of EU_QUESTIONS) {
    const value = (raw as Record<string, unknown>)[q.id];
    if (q.kind === "boolean" && typeof value === "boolean") out[q.id] = value;
    if (
      q.kind === "choice" &&
      typeof value === "string" &&
      q.options?.some((o) => o.value === value)
    )
      out[q.id] = value;
  }
  return out;
}

/** Questions still needed, given what was answered so far (out-of-scope systems need nothing more). */
export function missingEuAnswers(
  answers: Record<string, string | boolean>,
): string[] {
  if (answers.in_eu === false) return [];
  return EU_QUESTIONS.filter((q) => {
    if (answers[q.id] !== undefined) return false;
    // The exception questions only matter for an Annex III area.
    if (q.group === "exception")
      return Boolean(
        answers.high_risk_area && answers.high_risk_area !== "none",
      );
    return true;
  }).map((q) => q.id);
}

export type EuCategory =
  | "prohibited"
  | "high"
  | "limited"
  | "minimal"
  | "out_of_scope";

export interface EuObligation {
  article: string;
  title: string;
  detail: string;
  /** The Pristine feature that produces evidence for it. */
  evidence: string;
}

const PROVIDER_HIGH: EuObligation[] = [
  {
    article: "Art. 9",
    title: "Risk management system",
    detail: "Identify, evaluate and mitigate risks across the whole lifecycle.",
    evidence: "risks",
  },
  {
    article: "Art. 10",
    title: "Data and data governance",
    detail:
      "Training, validation and test data are relevant, representative and checked for bias.",
    evidence: "datasets",
  },
  {
    article: "Art. 11",
    title: "Technical documentation",
    detail:
      "Keep Annex IV documentation up to date before it is placed on the market.",
    evidence: "factsheet",
  },
  {
    article: "Art. 12",
    title: "Record-keeping",
    detail: "Log events automatically over the system's lifetime.",
    evidence: "records",
  },
  {
    article: "Art. 13",
    title: "Transparency to deployers",
    detail: "Instructions for use: purpose, accuracy, limits, human oversight.",
    evidence: "factsheet",
  },
  {
    article: "Art. 14",
    title: "Human oversight",
    detail: "People can understand, monitor, override and stop it.",
    evidence: "oversight",
  },
  {
    article: "Art. 15",
    title: "Accuracy, robustness and cybersecurity",
    detail: "Declared accuracy levels, resilience to errors and attacks.",
    evidence: "evaluations",
  },
  {
    article: "Art. 17",
    title: "Quality management system",
    detail: "Documented policies and procedures for compliance.",
    evidence: "approvals",
  },
  {
    article: "Art. 43",
    title: "Conformity assessment",
    detail: "Assess conformity before it is placed on the market.",
    evidence: "approvals",
  },
  {
    article: "Art. 49",
    title: "Registration",
    detail: "Register it in the EU database before use.",
    evidence: "manual",
  },
  {
    article: "Art. 72",
    title: "Post-market monitoring",
    detail: "Collect and review performance data after release.",
    evidence: "evaluations",
  },
  {
    article: "Art. 73",
    title: "Serious incident reporting",
    detail: "Report serious incidents to the authority.",
    evidence: "issues",
  },
];

const DEPLOYER_HIGH: EuObligation[] = [
  {
    article: "Art. 26",
    title: "Use as instructed, with oversight",
    detail:
      "Assign competent people to oversee it, monitor it, keep its logs for at least six months and inform affected workers.",
    evidence: "oversight",
  },
  {
    article: "Art. 26(6)",
    title: "Keep logs",
    detail: "Keep automatically generated logs for at least six months.",
    evidence: "records",
  },
  {
    article: "Art. 27",
    title: "Fundamental rights impact assessment",
    detail:
      "Required for public bodies and for credit scoring or life and health insurance pricing.",
    evidence: "assessment",
  },
  {
    article: "Art. 72",
    title: "Monitor in use",
    detail: "Watch how it performs and tell the provider about risks.",
    evidence: "evaluations",
  },
  {
    article: "Art. 73",
    title: "Serious incidents",
    detail: "Tell the provider and the authority about serious incidents.",
    evidence: "issues",
  },
  {
    article: "Art. 86",
    title: "Right to explanation",
    detail: "People affected by a decision can ask for an explanation.",
    evidence: "factsheet",
  },
];

const TRANSPARENCY: EuObligation[] = [
  {
    article: "Art. 50",
    title: "Tell people they are dealing with AI",
    detail:
      "Disclose AI interaction, mark synthetic content, label deepfakes and inform people of emotion recognition.",
    evidence: "factsheet",
  },
];

const ALL_SYSTEMS: EuObligation[] = [
  {
    article: "Art. 4",
    title: "AI literacy",
    detail: "Staff who build or use it have enough AI literacy.",
    evidence: "manual",
  },
];

export interface EuResult {
  category: EuCategory;
  reasons: string[];
  obligations: EuObligation[];
  role: "provider" | "deployer" | null;
}

export function classifyEuAiAct(
  answers: Record<string, string | boolean>,
): EuResult {
  const role =
    answers.role === "provider" || answers.role === "deployer"
      ? answers.role
      : null;
  if (answers.in_eu === false)
    return {
      category: "out_of_scope",
      reasons: ["Not offered or used in the EU."],
      obligations: [],
      role,
    };
  const label = (id: string) =>
    EU_QUESTIONS.find((q) => q.id === id)?.text ?? id;

  const prohibited = EU_QUESTIONS.filter(
    (q) => q.group === "prohibited" && answers[q.id] === true,
  );
  if (prohibited.length) {
    return {
      category: "prohibited",
      reasons: prohibited.map(
        (q) =>
          `Prohibited practice (Art. 5): ${label(q.id)
            .replace(/^Does it /, "")
            .replace(/\?$/, "")}.`,
      ),
      obligations: [],
      role,
    };
  }

  const transparency = EU_QUESTIONS.filter(
    (q) => q.group === "transparency" && answers[q.id] === true,
  );
  const area =
    typeof answers.high_risk_area === "string"
      ? answers.high_risk_area
      : "none";
  const areaLabel =
    EU_HIGH_RISK_AREAS.find((a) => a.value === area)?.label ?? area;
  const reasons: string[] = [];
  let high = false;
  if (answers.safety_component === true) {
    high = true;
    reasons.push("Safety component of a regulated product (Art. 6(1)).");
  }
  if (area !== "none") {
    // Art. 6(3): an Annex III system is not high-risk when it does a narrow task and does not profile people.
    if (answers.profiling === true) {
      high = true;
      reasons.push(
        `Annex III area (${areaLabel}) and it profiles people, which is always high-risk.`,
      );
    } else if (answers.narrow_task === true) {
      reasons.push(
        `Annex III area (${areaLabel}), but it only does a narrow or preparatory task (Art. 6(3) exception). Document this decision.`,
      );
    } else {
      high = true;
      reasons.push(`Used in an Annex III area: ${areaLabel}.`);
    }
  }
  if (high) {
    const base = role === "deployer" ? DEPLOYER_HIGH : PROVIDER_HIGH;
    return {
      category: "high",
      reasons,
      obligations: [
        ...base,
        ...(transparency.length ? TRANSPARENCY : []),
        ...ALL_SYSTEMS,
      ],
      role,
    };
  }
  if (transparency.length) {
    return {
      category: "limited",
      reasons: [
        ...reasons,
        ...transparency.map(
          (q) =>
            `Transparency duty (Art. 50): ${label(q.id)
              .replace(/^(Do|Does) (people|it) /, "")
              .replace(/\?$/, "")}.`,
        ),
      ],
      obligations: [...TRANSPARENCY, ...ALL_SYSTEMS],
      role,
    };
  }
  return {
    category: "minimal",
    reasons: [
      ...reasons,
      "No prohibited practice, high-risk use or transparency duty.",
    ],
    obligations: ALL_SYSTEMS,
    role,
  };
}

/** The internal risk tier from the questionnaire, raised by the EU AI Act category. */
export function riskTier(
  answers: Record<string, string>,
  eu: EuCategory | null,
): { tier: Tier; points: number; reasons: string[] } {
  const points = RISK_QUESTIONS.reduce(
    (sum, q) =>
      sum + (q.options.find((o) => o.value === answers[q.id])?.points ?? 0),
    0,
  );
  const reasons: string[] = [`${points} of ${MAX_RISK_POINTS} risk points.`];
  if (eu === "prohibited")
    return {
      tier: "prohibited",
      points,
      reasons: [
        ...reasons,
        "It falls under a practice the EU AI Act prohibits.",
      ],
    };
  let tier: Tier = points >= 10 ? "high" : points >= 5 ? "medium" : "low";
  if (eu === "high" && tier !== "high") {
    tier = "high";
    reasons.push("Raised to high: high-risk under the EU AI Act.");
  }
  if (
    answers.decisions_about_people === "yes" &&
    answers.data === "sensitive" &&
    tier !== "high"
  ) {
    tier = "high";
    reasons.push(
      "Raised to high: decisions about people using sensitive personal data.",
    );
  }
  if (
    answers.impact === "harm" &&
    answers.autonomy === "autonomous" &&
    tier !== "high"
  ) {
    tier = "high";
    reasons.push(
      "Raised to high: can cause harm and acts without a person checking.",
    );
  }
  if (eu === "limited" && tier === "low") {
    tier = "medium";
    reasons.push("Raised to medium: EU AI Act transparency duties apply.");
  }
  return { tier, points, reasons };
}

// ---------------------------------------------------------------------------
// AI risk library
// ---------------------------------------------------------------------------

export type RiskCategory =
  | "accuracy"
  | "fairness"
  | "privacy"
  | "security"
  | "transparency"
  | "misuse"
  | "agentic"
  | "governance";

export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  accuracy: "Accuracy and robustness",
  fairness: "Fairness",
  privacy: "Privacy",
  security: "Security",
  transparency: "Transparency",
  misuse: "Harmful content and misuse",
  agentic: "Agents and autonomy",
  governance: "Governance and third parties",
};

/** Pristine controls a risk can be mitigated with. */
export const CONTROLS: Record<string, string> = {
  eval_faithfulness: "Evaluation: faithfulness to the source",
  eval_relevance: "Evaluation: answer relevance",
  eval_correctness: "Evaluation: correctness against expected answers",
  eval_pii: "Evaluation: personal data in outputs",
  eval_harmful: "Evaluation: harmful content",
  eval_injection: "Evaluation: prompt-injection attempts",
  eval_drift: "Evaluation: input drift",
  eval_feedback: "Evaluation: user feedback",
  ops_errors: "Monitoring: error rate and latency",
  human_review: "A person reviews outputs before use",
  approval_policy: "Agent policy: risky actions wait for approval",
  scopes: "Agent keys with least-privilege scopes",
  kill_switch: "Kill switch and suspension",
  dlp_masking: "Personal data masked before prompts leave Pristine",
  prompt_checks: "Prompt checks before release",
  cost_budget: "AI cost budgets and alerts",
  vendor_review: "Vendor risk assessment",
  disclosure: "Users are told they are dealing with AI",
  bias_testing: "Bias testing across groups",
  data_review: "Data source and consent review",
  access_logging: "Activity log of every agent action",
  incident_process: "Incident response playbook",
  fallback: "Fallback when the AI fails",
};

export interface LibraryRisk {
  code: string;
  category: RiskCategory;
  title: string;
  description: string;
  /** Which use cases it applies to; suggested from the assessment. */
  when: {
    types?: AiType[];
    personalData?: boolean;
    decisionsAboutPeople?: boolean;
    external?: boolean;
    thirdParty?: boolean;
    autonomous?: boolean;
  };
  controls: string[];
}

export const RISK_LIBRARY: LibraryRisk[] = [
  {
    code: "ACC-01",
    category: "accuracy",
    title: "Made-up answers",
    description:
      "It states things that are not true or not supported by its sources.",
    when: { types: ["generative", "agentic"] },
    controls: ["eval_faithfulness", "human_review", "fallback"],
  },
  {
    code: "ACC-02",
    category: "accuracy",
    title: "Off-topic or unhelpful answers",
    description: "Answers miss the question or wander off it.",
    when: { types: ["generative", "agentic"] },
    controls: ["eval_relevance", "eval_feedback"],
  },
  {
    code: "ACC-03",
    category: "accuracy",
    title: "Wrong predictions",
    description: "Accuracy is lower than the business relies on.",
    when: { types: ["predictive"] },
    controls: ["eval_correctness", "human_review"],
  },
  {
    code: "ACC-04",
    category: "accuracy",
    title: "Drift",
    description:
      "Inputs or behaviour change over time, so earlier tests no longer hold.",
    when: {},
    controls: ["eval_drift", "eval_correctness"],
  },
  {
    code: "ACC-05",
    category: "accuracy",
    title: "Outages and slow responses",
    description:
      "The model or provider fails or is too slow when people depend on it.",
    when: { thirdParty: true },
    controls: ["ops_errors", "fallback"],
  },
  {
    code: "FAI-01",
    category: "fairness",
    title: "Unfair outcomes for groups of people",
    description:
      "Results are systematically worse for some groups (age, gender, ethnicity, disability).",
    when: { decisionsAboutPeople: true },
    controls: ["bias_testing", "human_review"],
  },
  {
    code: "FAI-02",
    category: "fairness",
    title: "Biased or stereotyped content",
    description: "Generated content reinforces stereotypes.",
    when: { types: ["generative"], external: true },
    controls: ["eval_harmful", "human_review"],
  },
  {
    code: "PRI-01",
    category: "privacy",
    title: "Personal data in outputs",
    description:
      "It reveals personal data it should not, from prompts, context or training data.",
    when: { personalData: true },
    controls: ["eval_pii", "dlp_masking"],
  },
  {
    code: "PRI-02",
    category: "privacy",
    title: "Personal data sent to a provider",
    description:
      "Prompts with personal data leave the company to a third-party model.",
    when: { personalData: true, thirdParty: true },
    controls: ["dlp_masking", "vendor_review"],
  },
  {
    code: "PRI-03",
    category: "privacy",
    title: "No lawful basis or consent for the data",
    description: "Data is used for a purpose people were not told about.",
    when: { personalData: true },
    controls: ["data_review"],
  },
  {
    code: "SEC-01",
    category: "security",
    title: "Prompt injection",
    description: "Inputs or retrieved content override its instructions.",
    when: { types: ["generative", "agentic"] },
    controls: ["eval_injection", "prompt_checks", "approval_policy"],
  },
  {
    code: "SEC-02",
    category: "security",
    title: "Secrets leaked in prompts or outputs",
    description: "API keys or passwords end up in prompts, logs or answers.",
    when: { types: ["generative", "agentic"] },
    controls: ["prompt_checks", "eval_pii", "dlp_masking"],
  },
  {
    code: "SEC-03",
    category: "security",
    title: "Poisoned or tampered data",
    description: "Someone manipulates the data it learns from or retrieves.",
    when: { types: ["predictive", "generative"] },
    controls: ["data_review", "eval_drift"],
  },
  {
    code: "TRA-01",
    category: "transparency",
    title: "People do not know it is AI",
    description:
      "Users or affected people are not told they are dealing with AI.",
    when: { external: true },
    controls: ["disclosure"],
  },
  {
    code: "TRA-02",
    category: "transparency",
    title: "Decisions cannot be explained",
    description: "Nobody can explain why it produced a given result.",
    when: { decisionsAboutPeople: true },
    controls: ["human_review", "access_logging"],
  },
  {
    code: "MIS-01",
    category: "misuse",
    title: "Harmful or abusive content",
    description: "It produces hateful, abusive, violent or explicit content.",
    when: { types: ["generative", "agentic"] },
    controls: ["eval_harmful", "human_review"],
  },
  {
    code: "MIS-02",
    category: "misuse",
    title: "Copyright and IP infringement",
    description: "Outputs reproduce protected material.",
    when: { types: ["generative"] },
    controls: ["human_review", "vendor_review"],
  },
  {
    code: "MIS-03",
    category: "misuse",
    title: "Over-reliance",
    description: "People trust outputs without checking them.",
    when: {},
    controls: ["human_review", "disclosure"],
  },
  {
    code: "AGT-01",
    category: "agentic",
    title: "Too much autonomy",
    description: "It takes consequential actions without a person deciding.",
    when: { autonomous: true },
    controls: ["approval_policy", "kill_switch", "human_review"],
  },
  {
    code: "AGT-02",
    category: "agentic",
    title: "Unsafe or unintended tool use",
    description:
      "It calls tools or APIs it should not, or with the wrong data.",
    when: { types: ["agentic"] },
    controls: ["scopes", "approval_policy", "access_logging"],
  },
  {
    code: "AGT-03",
    category: "agentic",
    title: "Runaway cost",
    description: "Loops or misuse drive up AI spend.",
    when: { types: ["agentic", "generative"] },
    controls: ["cost_budget", "kill_switch"],
  },
  {
    code: "GOV-01",
    category: "governance",
    title: "Third-party model risk",
    description:
      "A vendor changes, retires or mishandles the model it depends on.",
    when: { thirdParty: true },
    controls: ["vendor_review", "eval_drift", "fallback"],
  },
  {
    code: "GOV-02",
    category: "governance",
    title: "No clear owner or oversight",
    description: "Nobody is accountable for how it behaves in production.",
    when: {},
    controls: ["human_review", "incident_process"],
  },
  {
    code: "GOV-03",
    category: "governance",
    title: "Breaking a law or regulation",
    description:
      "It is used in a way regulation does not allow, or duties are missed.",
    when: { decisionsAboutPeople: true },
    controls: ["incident_process", "access_logging"],
  },
];

/** Library risks that fit a use case, from its type and assessment answers. */
export function suggestRisks(input: {
  type: AiType | null;
  riskAnswers: Record<string, string>;
}): LibraryRisk[] {
  const a = input.riskAnswers;
  const facts = {
    personalData: a.data === "personal" || a.data === "sensitive",
    decisionsAboutPeople: a.decisions_about_people === "yes",
    external: a.audience === "external",
    thirdParty: a.third_party === "yes",
    autonomous: a.autonomy === "autonomous",
  };
  return RISK_LIBRARY.filter((risk) => {
    const w = risk.when;
    if (w.types && (!input.type || !w.types.includes(input.type))) return false;
    if (w.personalData && !facts.personalData) return false;
    if (w.decisionsAboutPeople && !facts.decisionsAboutPeople) return false;
    if (w.external && !facts.external) return false;
    if (w.thirdParty && !facts.thirdParty) return false;
    if (w.autonomous && !facts.autonomous && input.type !== "agentic")
      return false;
    return true;
  });
}

/** Likelihood × impact on a 5×5 grid. */
export const riskScore = (likelihood: number, impact: number): number =>
  likelihood * impact;
export const riskLevel = (
  score: number,
): "low" | "medium" | "high" | "critical" =>
  score >= 20
    ? "critical"
    : score >= 12
      ? "high"
      : score >= 6
        ? "medium"
        : "low";

// ---------------------------------------------------------------------------
// Evaluation metrics
// ---------------------------------------------------------------------------

export type MetricKey =
  | "pii_in_output"
  | "harmful_content"
  | "injection_attempts"
  | "answer_relevance"
  | "faithfulness"
  | "correctness"
  | "refusal_rate"
  | "negative_feedback"
  | "input_drift"
  | "error_rate"
  | "latency_p95";

export interface MetricDef {
  key: MetricKey;
  label: string;
  description: string;
  /** "max": fails above the threshold; "min": fails below it. */
  direction: "max" | "min";
  unit: "rate" | "score" | "ms";
  thresholds: Record<Exclude<Tier, "prohibited">, number>;
  /** Records it needs to compute. */
  needs:
    | "records"
    | "context"
    | "expected"
    | "feedback"
    | "executions"
    | "baseline";
  control: string;
}

export const METRICS: MetricDef[] = [
  {
    key: "pii_in_output",
    label: "Personal data in outputs",
    description:
      "Share of outputs with emails, phone numbers, card numbers, national IDs or secrets.",
    direction: "max",
    unit: "rate",
    thresholds: { low: 0.01, medium: 0, high: 0 },
    needs: "records",
    control: "eval_pii",
  },
  {
    key: "harmful_content",
    label: "Harmful content",
    description:
      "Share of outputs with hateful, abusive, violent or explicit language.",
    direction: "max",
    unit: "rate",
    thresholds: { low: 0.02, medium: 0.01, high: 0 },
    needs: "records",
    control: "eval_harmful",
  },
  {
    key: "injection_attempts",
    label: "Prompt-injection attempts",
    description:
      "Share of inputs trying to override the system's instructions.",
    direction: "max",
    unit: "rate",
    thresholds: { low: 0.1, medium: 0.05, high: 0.02 },
    needs: "records",
    control: "eval_injection",
  },
  {
    key: "answer_relevance",
    label: "Answer relevance",
    description: "How much of the question each answer addresses (0 to 1).",
    direction: "min",
    unit: "score",
    thresholds: { low: 0.2, medium: 0.3, high: 0.4 },
    needs: "records",
    control: "eval_relevance",
  },
  {
    key: "faithfulness",
    label: "Faithfulness",
    description:
      "Share of answer sentences supported by the context given (0 to 1).",
    direction: "min",
    unit: "score",
    thresholds: { low: 0.6, medium: 0.7, high: 0.8 },
    needs: "context",
    control: "eval_faithfulness",
  },
  {
    key: "correctness",
    label: "Correctness",
    description:
      "Word overlap (F1) between answers and the expected answers (0 to 1).",
    direction: "min",
    unit: "score",
    thresholds: { low: 0.4, medium: 0.5, high: 0.6 },
    needs: "expected",
    control: "eval_correctness",
  },
  {
    key: "refusal_rate",
    label: "Refusals",
    description: "Share of answers that decline to help.",
    direction: "max",
    unit: "rate",
    thresholds: { low: 0.3, medium: 0.2, high: 0.15 },
    needs: "records",
    control: "eval_relevance",
  },
  {
    key: "negative_feedback",
    label: "Negative feedback",
    description: "Share of rated answers that users marked as bad.",
    direction: "max",
    unit: "rate",
    thresholds: { low: 0.4, medium: 0.3, high: 0.2 },
    needs: "feedback",
    control: "eval_feedback",
  },
  {
    key: "input_drift",
    label: "Input drift",
    description:
      "How different recent inputs are from the inputs it was validated on (0 = same, 1 = unrelated).",
    direction: "max",
    unit: "score",
    thresholds: { low: 0.5, medium: 0.4, high: 0.3 },
    needs: "baseline",
    control: "eval_drift",
  },
  {
    key: "error_rate",
    label: "Error rate",
    description:
      "Share of AI calls through Pristine that failed (linked prompts and agents).",
    direction: "max",
    unit: "rate",
    thresholds: { low: 0.1, medium: 0.05, high: 0.02 },
    needs: "executions",
    control: "ops_errors",
  },
  {
    key: "latency_p95",
    label: "Latency (95th percentile)",
    description:
      "95% of AI calls finished within this time (linked prompts and agents).",
    direction: "max",
    unit: "ms",
    thresholds: { low: 20000, medium: 15000, high: 10000 },
    needs: "executions",
    control: "ops_errors",
  },
];

export const METRIC_KEYS = METRICS.map((m) => m.key);
