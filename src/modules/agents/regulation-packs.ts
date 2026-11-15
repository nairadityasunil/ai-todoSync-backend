import type { GovernanceSettings } from "./hybrid.js";
import { MORE_PACKS } from "./regulation-packs-more.js";
import type { IPolicyMatch, PolicyEffect, PolicyMode } from "./model.js";

/**
 * Policy packs for real laws. Each item cites the provision it supports and
 * says how Pristine covers it:
 *  - policy:   an agent policy the pack installs (block / hold / log);
 *  - setting:  a protection the pack switches on (never loosened);
 *  - built_in: something Pristine always does;
 *  - manual:   an obligation Pristine cannot meet for you (shown as a to-do).
 *
 * The packs help an organisation meet these obligations for the AI agents it
 * governs here. They are not legal advice and do not by themselves make an
 * organisation compliant.
 */

export type PackItemKind = "policy" | "setting" | "built_in" | "manual";

export interface PackPolicy {
  name: string;
  description: string;
  effect: PolicyEffect;
  /** Mode when applied "as recommended"; "Start in advisory" puts every pack policy in advisory. */
  mode: Exclude<PolicyMode, "simulation">;
  priority: number;
  match: IPolicyMatch;
}

export interface PackSettings {
  governance?: Partial<
    Pick<
      GovernanceSettings,
      | "dlpMode"
      | "threatDetection"
      | "incidentAutoContain"
      | "criticalAutoSuspend"
      | "anomalyDetection"
      | "correlation"
      | "sessionRisk"
      | "classificationEnforce"
      | "policyChangeApproval"
    >
  >;
  aiDataMasking?: boolean;
  approvedVendorsOnly?: boolean;
  requireAgentKeys?: boolean;
}

export interface PackItem {
  id: string;
  title: string;
  /** The provision, e.g. "Art. 14 – Human oversight". */
  basis: string;
  kind: PackItemKind;
  /** What Pristine does for this item (or, for manual items, what you need to do). */
  howCovered: string;
  policy?: PackPolicy;
  settings?: PackSettings;
  /** Settings used when the pack is applied in advisory: nothing that blocks. */
  advisorySettings?: PackSettings;
  /** Not applied with the whole pack (only some organisations need it); apply it on its own. */
  optional?: boolean;
}

export interface RegulationPack {
  id: string;
  name: string;
  jurisdiction: string;
  /** An AI law, or a general privacy law. */
  category: "ai" | "privacy";
  /** Official title and citation of the law. */
  source: string;
  /** Official text. */
  url: string;
  /** Who the law applies to, in one or two sentences. */
  scope: string;
  items: PackItem[];
}

/** Actions that read or change people's data (workspace members, users, invitations). */
const PEOPLE_DATA = [
  "member:*",
  "user:*",
  "invitation:*",
  "workspace:list_members",
  "project:list_members",
  "project:add_member",
];

const destructiveNeedsPerson = (name: string, basis: string): PackPolicy => ({
  name,
  description: `Deletes and other irreversible agent actions wait for a person (${basis}).`,
  effect: "require_approval",
  mode: "enforce",
  priority: 220,
  match: { minRisk: "destructive" },
});

const unregisteredReadOnly = (name: string, basis: string): PackPolicy => ({
  name,
  description: `Scripts and tools using a person's login instead of their own agent key cannot change data (${basis}).`,
  effect: "deny",
  mode: "enforce",
  priority: 240,
  match: { agentKinds: ["detected"], minRisk: "write" },
});

const FIRST_PACKS: RegulationPack[] = [
  /* ---------------------------------------------------------------- */
  {
    id: "eu-ai-act",
    name: "EU AI Act",
    jurisdiction: "European Union",
    category: "ai",
    source: "Regulation (EU) 2024/1689 (Artificial Intelligence Act)",
    url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj",
    scope:
      "Most duties below apply to providers and deployers of high-risk AI systems (Art. 6 and Annex III); Art. 5 and Art. 50 apply more widely. Applying the pack holds every agent in this workspace to the high-risk standard.",
    items: [
      {
        id: "human-oversight",
        title: "High-risk AI actions need human oversight",
        basis: "Art. 14 – Human oversight",
        kind: "policy",
        howCovered:
          "Irreversible agent actions wait for a person, who can approve, reject or scope them down. Member and permission changes are held as well.",
        policy: destructiveNeedsPerson(
          "EU AI Act Art. 14: a person approves irreversible actions",
          "EU AI Act Art. 14",
        ),
      },
      {
        id: "human-oversight-permissions",
        title: "Changes to people's access need human oversight",
        basis: "Art. 14 – Human oversight",
        kind: "policy",
        howCovered:
          "Agents adding members or changing roles and permissions wait for a person.",
        policy: {
          name: "EU AI Act Art. 14: a person approves access changes",
          description:
            "Member, role and permission changes by agents wait for a person (EU AI Act Art. 14).",
          effect: "require_approval",
          mode: "enforce",
          priority: 210,
          match: { minRisk: "sensitive_write" },
        },
      },
      {
        id: "prohibited-practices",
        title: "Prohibited AI practices",
        basis: "Art. 5 – Prohibited AI practices",
        kind: "manual",
        howCovered:
          "Pristine cannot tell what an AI system is used for, so it cannot detect these practices. Confirm none of your agents is used for the practices in Art. 5 (e.g. manipulative techniques, social scoring, untargeted facial-image scraping, emotion recognition at work). Block any agent that is, from its detail panel.",
      },
      {
        id: "record-keeping",
        title: "Automatic logging of AI system activity",
        basis: "Art. 12 – Record-keeping; Art. 26(6) – deployers keep logs",
        kind: "built_in",
        howCovered:
          "Every agent action is logged with who decided and why, and can be exported (CSV, JSON, evidence pack). Pristine keeps the log for 90 days; Art. 26(6) asks deployers of high-risk systems to keep logs for at least six months, so export an evidence pack at least every 90 days.",
      },
      {
        id: "risk-management",
        title: "Risk management for AI agents",
        basis: "Art. 9 – Risk management system",
        kind: "setting",
        howCovered:
          "Turns on behaviour baselines, session risk, threat detection, critical-risk suspension and incident containment, so risky behaviour is held or stopped. Your documented risk-management process stays your responsibility.",
        settings: {
          governance: {
            anomalyDetection: true,
            sessionRisk: true,
            threatDetection: true,
            criticalAutoSuspend: true,
            incidentAutoContain: true,
            correlation: true,
          },
        },
        advisorySettings: {
          governance: {
            anomalyDetection: true,
            sessionRisk: true,
            threatDetection: true,
            correlation: true,
          },
        },
      },
      {
        id: "transparency",
        title: "Transparency about AI actions",
        basis:
          "Art. 13 – Transparency to deployers; Art. 50 – Transparency for certain AI systems",
        kind: "manual",
        howCovered:
          'Pristine labels every change an agent makes with the agent\'s name and records system decisions as "System decided". Telling people they are interacting with an AI system, and marking AI-generated content (Art. 50), is up to you in your own products.',
      },
      {
        id: "data-governance",
        title: "Data governance for AI agents",
        basis: "Art. 10 – Data and data governance",
        kind: "setting",
        howCovered:
          "Blocks secrets and holds personal data in what agents send (DLP), and enforces data labels so restricted data never reaches AI models. Art. 10 also covers the quality of training, validation and test data, which is outside Pristine.",
        settings: {
          governance: { dlpMode: "enforce", classificationEnforce: true },
        },
        advisorySettings: { governance: { dlpMode: "monitor" } },
      },
      {
        id: "labelled-data",
        title: "Confidential and restricted data need a person",
        basis: "Art. 10 – Data and data governance",
        kind: "policy",
        howCovered:
          "Agent changes to projects or tasks labelled Confidential or Restricted wait for a person.",
        policy: {
          name: "EU AI Act Art. 10: a person approves changes to labelled data",
          description:
            "Agent changes to Confidential or Restricted data wait for a person (EU AI Act Art. 10).",
          effect: "require_approval",
          mode: "enforce",
          priority: 230,
          match: {
            minRisk: "write",
            classifications: ["confidential", "restricted"],
          },
        },
      },
      {
        id: "unregistered",
        title: "Undeclared AI restricted to reading",
        basis:
          "Supports Art. 26(1) – use in line with instructions, and Art. 49 – registration",
        kind: "policy",
        howCovered:
          "AI tools and scripts that use a person's login instead of a declared agent key cannot change data until they are registered with their own key.",
        policy: unregisteredReadOnly(
          "EU AI Act: undeclared AI cannot change data",
          "EU AI Act Art. 26(1), Art. 49",
        ),
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: "ccpa-cpra",
    name: "California CCPA / CPRA",
    jurisdiction: "California, USA",
    category: "privacy",
    source:
      "California Consumer Privacy Act of 2018, as amended by the California Privacy Rights Act (Cal. Civ. Code § 1798.100 et seq.) and its regulations (Cal. Code Regs. tit. 11, § 7000 et seq.)",
    url: "https://cppa.ca.gov/regulations/",
    scope:
      "Applies to businesses that meet the CCPA thresholds and handle personal information of California residents, including employees and contractors.",
    items: [
      {
        id: "pi-access",
        title: "Agent access to personal information is controlled",
        basis:
          "§ 1798.100(c) – collection and use limited to what is reasonably necessary",
        kind: "policy",
        howCovered:
          "Agents reading or changing people's records (members, users, invitations) are logged as needing approval, so you can see every access. Switch this policy to enforce to hold each access for a person.",
        policy: {
          name: "CCPA: agent access to personal information",
          description:
            "Agent reads and changes of people's records are recorded as needing approval (CCPA § 1798.100(c)).",
          effect: "require_approval",
          mode: "advisory",
          priority: 200,
          match: { tools: PEOPLE_DATA },
        },
      },
      {
        id: "pi-changes",
        title: "Changes to personal information need a person",
        basis: "§ 1798.100(c); § 1798.106 – right to correct",
        kind: "policy",
        howCovered:
          "Agents adding, changing or removing people's records wait for a person.",
        policy: {
          name: "CCPA: a person approves changes to personal information",
          description:
            "Agent changes to members, roles and invitations wait for a person (CCPA).",
          effect: "require_approval",
          mode: "enforce",
          priority: 210,
          match: { minRisk: "sensitive_write" },
        },
      },
      {
        id: "no-sale-sharing",
        title: "Personal information is not sold or shared by default",
        basis: "§ 1798.120 – right to opt out of sale or sharing",
        kind: "setting",
        howCovered:
          "Only approved third parties can receive data from your agents, and links to unapproved sites in what agents send are blocked. Honouring opt-out requests from consumers is up to you.",
        settings: {
          approvedVendorsOnly: true,
          governance: { dlpMode: "enforce" },
        },
        advisorySettings: { governance: { dlpMode: "monitor" } },
      },
      {
        id: "sensitive-pi",
        title: "Sensitive personal information handled more strictly",
        basis:
          "§ 1798.121 – right to limit use of sensitive personal information; § 1798.140(ae)",
        kind: "setting",
        howCovered:
          "DLP blocks card numbers, government ID numbers and secrets in what agents send, and personal data is masked before prompts reach AI providers.",
        settings: { governance: { dlpMode: "enforce" }, aiDataMasking: true },
        advisorySettings: { governance: { dlpMode: "monitor" } },
      },
      {
        id: "admt",
        title: "Automated decision-making is logged",
        basis:
          "CCPA regulations on automated decision-making technology (Cal. Code Regs. tit. 11, § 7200 et seq.)",
        kind: "built_in",
        howCovered:
          "Every decision an agent or the system makes is logged with its reason and can be exported. Pre-use notices, opt-outs and access requests for significant decisions are up to you.",
      },
      {
        id: "minimization",
        title: "Agents keep only the access they need",
        basis: "§ 1798.100(c) – data minimization and purpose limitation",
        kind: "built_in",
        howCovered:
          "Each agent's reach map shows access it never used, with one click to remove it; access reviews ask owners to confirm agents regularly.",
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: "colorado-ai-act",
    name: "Colorado AI Act",
    jurisdiction: "Colorado, USA",
    category: "ai",
    source:
      "Colorado Artificial Intelligence Act, SB 24-205 (C.R.S. § 6-1-1701 et seq.)",
    url: "https://leg.colorado.gov/bills/sb24-205",
    scope:
      "Applies to developers and deployers of high-risk AI systems that make, or are a substantial factor in making, consequential decisions (e.g. employment, lending, housing, insurance, education, healthcare). Use it if your agents take part in such decisions.",
    items: [
      {
        id: "impact-assessment",
        title: "Impact assessments for high-risk AI",
        basis: "§ 6-1-1703(3) – impact assessments",
        kind: "manual",
        howCovered:
          "Write and keep the impact assessment yourself. Pristine supplies evidence for it: each agent's risk factors, its activity and an exportable evidence pack.",
      },
      {
        id: "decisions-logged",
        title: "Every agent decision is recorded",
        basis: "§ 6-1-1703(3) – records supporting impact assessments",
        kind: "built_in",
        howCovered:
          "Every agent action is logged with the policy or rule that decided it and the person who approved it.",
      },
      {
        id: "consumer-notice",
        title: "Notice to consumers about consequential decisions",
        basis: "§ 6-1-1703(4) – notice to consumers",
        kind: "manual",
        howCovered:
          "Notifying consumers that a high-risk AI system is used to make a consequential decision is done in your own product or process.",
      },
      {
        id: "human-review",
        title: "Human review of adverse decisions",
        basis: "§ 6-1-1703(4) – correction and appeal with human review",
        kind: "policy",
        howCovered:
          "Irreversible agent actions wait for a person, and each approval or rejection is recorded with who decided. Offering consumers an appeal is up to you.",
        policy: destructiveNeedsPerson(
          "Colorado AI Act: a person reviews irreversible actions",
          "Colorado SB 24-205",
        ),
      },
      {
        id: "reasonable-care",
        title: "Reasonable care against algorithmic discrimination",
        basis:
          "§ 6-1-1703(1) – duty of reasonable care; § 6-1-1703(2) – risk management policy",
        kind: "setting",
        howCovered:
          "Turns on behaviour baselines and threat detection so unusual agent behaviour is flagged. Pristine cannot test models for discrimination; your risk management policy and testing remain your responsibility.",
        settings: {
          governance: {
            anomalyDetection: true,
            threatDetection: true,
            sessionRisk: true,
          },
        },
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: "india-dpdp",
    name: "India DPDP Act",
    jurisdiction: "India",
    category: "privacy",
    source: "Digital Personal Data Protection Act, 2023 (Act No. 22 of 2023)",
    url: "https://www.meity.gov.in/data-protection-framework",
    scope:
      "Applies to processing of digital personal data within India, and outside India when it relates to offering goods or services to people in India.",
    items: [
      {
        id: "lawful-processing",
        title: "Agents handle personal data only when allowed",
        basis: "Section 4 – Grounds for processing personal data",
        kind: "policy",
        howCovered:
          "Agent changes to people's records wait for a person, who confirms there is a lawful ground.",
        policy: {
          name: "DPDP Act s.4: a person approves changes to personal data",
          description:
            "Agent changes to members, roles and invitations wait for a person (DPDP Act, Section 4).",
          effect: "require_approval",
          mode: "enforce",
          priority: 210,
          match: { minRisk: "sensitive_write" },
        },
      },
      {
        id: "pd-access",
        title: "Agent access to personal data is recorded",
        basis:
          "Section 4 – Grounds for processing; Section 8(1) – Data Fiduciary responsible for processing",
        kind: "policy",
        howCovered:
          "Agents reading people's records are logged as needing approval. Switch to enforce to hold every access for a person.",
        policy: {
          name: "DPDP Act: agent access to personal data",
          description:
            "Agent reads of people's records are recorded as needing approval (DPDP Act, Sections 4 and 8).",
          effect: "require_approval",
          mode: "advisory",
          priority: 200,
          match: { tools: PEOPLE_DATA },
        },
      },
      {
        id: "consent",
        title: "Consent",
        basis: "Section 6 – Consent",
        kind: "manual",
        howCovered:
          "Pristine does not hold consent records. Collect and manage consent (or use a Consent Manager) in your own systems before agents process that data.",
      },
      {
        id: "principal-rights",
        title: "Rights of Data Principals",
        basis:
          "Sections 11–14 – access, correction and erasure, grievance redressal, nomination",
        kind: "built_in",
        howCovered:
          "The activity log shows which agent touched whose data and when, and can be exported to answer requests. Handling the requests themselves is up to you.",
      },
      {
        id: "security-safeguards",
        title: "Security safeguards against personal data breaches",
        basis: "Section 8(5) – reasonable security safeguards",
        kind: "setting",
        howCovered:
          "Turns on DLP (including Aadhaar and PAN numbers), threat detection, incident containment and suspension of critical-risk agents, and masks personal data sent to AI providers.",
        settings: {
          governance: {
            dlpMode: "enforce",
            threatDetection: true,
            incidentAutoContain: true,
            criticalAutoSuspend: true,
          },
          aiDataMasking: true,
        },
        advisorySettings: {
          governance: { dlpMode: "monitor", threatDetection: true },
        },
      },
      {
        id: "breach-intimation",
        title: "Breach intimation",
        basis: "Section 8(6) – intimation of personal data breach",
        kind: "manual",
        howCovered:
          "Incidents record what happened and can be exported, and webhooks can alert your team at once. Informing the Data Protection Board and each affected Data Principal is up to you.",
      },
      {
        id: "significant-fiduciary",
        title: "Extra controls for Significant Data Fiduciaries",
        basis:
          "Section 10 – Additional obligations of Significant Data Fiduciary",
        kind: "setting",
        howCovered:
          "Policy changes need a second admin, and session risk and behaviour baselines are on. Only for organisations notified as Significant Data Fiduciaries; appointing a Data Protection Officer, independent audits and impact assessments are up to you.",
        settings: {
          governance: {
            policyChangeApproval: true,
            sessionRisk: true,
            anomalyDetection: true,
          },
        },
        optional: true,
      },
      {
        id: "cross-border",
        title: "Cross-border transfers",
        basis: "Section 16 – Processing of personal data outside India",
        kind: "manual",
        howCovered:
          "The Central Government may restrict transfers to countries it notifies. If that affects you, set Allowed data regions in Settings and turn on Enforce compliance: AI providers and vendors outside those regions are then blocked.",
      },
      {
        id: "unauthorised",
        title: "Unauthorised processing restricted",
        basis: "Section 4 – Grounds for processing; Section 8(1)",
        kind: "policy",
        howCovered:
          "AI tools and scripts using a person's login instead of an authorised agent key cannot change data.",
        policy: unregisteredReadOnly(
          "DPDP Act: unauthorised tools cannot change data",
          "DPDP Act, Sections 4 and 8",
        ),
      },
    ],
  },
];

export const REGULATION_PACKS: RegulationPack[] = [
  ...FIRST_PACKS,
  ...MORE_PACKS,
];

export const packById = (id: string): RegulationPack | undefined =>
  REGULATION_PACKS.find((p) => p.id === id);

const DLP_RANK = { off: 0, monitor: 1, enforce: 2 } as const;

/** Settings that are not yet as strict as an item asks; never loosens anything. */
export function missingSettings(
  wanted: PackSettings | undefined,
  current: {
    governance: GovernanceSettings;
    aiDataMasking: boolean;
    approvedVendorsOnly: boolean;
    requireAgentKeys: boolean;
  },
): PackSettings {
  const out: PackSettings = {};
  if (!wanted) return out;
  const gov: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted.governance ?? {})) {
    if (key === "dlpMode") {
      const want = value as keyof typeof DLP_RANK;
      if (DLP_RANK[current.governance.dlpMode] < DLP_RANK[want])
        gov.dlpMode = want;
    } else if (
      value === true &&
      !(current.governance as unknown as Record<string, unknown>)[key]
    ) {
      gov[key] = true;
    }
  }
  if (Object.keys(gov).length)
    out.governance = gov as PackSettings["governance"];
  if (wanted.aiDataMasking && !current.aiDataMasking) out.aiDataMasking = true;
  if (wanted.approvedVendorsOnly && !current.approvedVendorsOnly)
    out.approvedVendorsOnly = true;
  if (wanted.requireAgentKeys && !current.requireAgentKeys)
    out.requireAgentKeys = true;
  return out;
}

export const isEmptySettings = (s: PackSettings): boolean =>
  !s.governance &&
  !s.aiDataMasking &&
  !s.approvedVendorsOnly &&
  !s.requireAgentKeys;
