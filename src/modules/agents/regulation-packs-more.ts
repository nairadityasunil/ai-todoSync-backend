import type {
  PackItem,
  PackPolicy,
  RegulationPack,
} from "./regulation-packs.js";

/**
 * More regulation packs: general privacy laws (built from one shape, since
 * they ask for the same kinds of control) and three US AI disclosure laws.
 * Every item cites the provision it supports. See regulation-packs.ts for
 * what the item kinds mean.
 */

const PEOPLE_DATA = [
  "member:*",
  "user:*",
  "invitation:*",
  "workspace:list_members",
  "project:list_members",
  "project:add_member",
];

const unregisteredReadOnly = (name: string, basis: string): PackPolicy => ({
  name,
  description: `Scripts and tools using a person's login instead of their own agent key cannot change data (${basis}).`,
  effect: "deny",
  mode: "enforce",
  priority: 240,
  match: { agentKinds: ["detected"], minRisk: "write" },
});

interface PrivacyLaw {
  id: string;
  name: string;
  /** Short name used in policy names, e.g. "GDPR". */
  short: string;
  jurisdiction: string;
  source: string;
  url: string;
  scope: string;
  /** What the law calls personal data, e.g. "personal information". */
  term: string;
  cite: {
    lawful: string;
    security: string;
    rights: string;
    minimisation: string;
    unauthorised: string;
    breach: string;
    consent?: string;
    transfer?: string;
    records?: string;
    sensitive?: string;
  };
  /** Who to tell about a breach, and when. */
  breachDuty: string;
  /** Extra wording for the transfer to-do. */
  transferNote?: string;
  extra?: PackItem[];
}

function privacyPack(law: PrivacyLaw): RegulationPack {
  const { cite, short, term } = law;
  const items: PackItem[] = [
    {
      id: "pd-changes",
      title: `Changes to ${term} need a person`,
      basis: cite.lawful,
      kind: "policy",
      howCovered: `Agents adding, changing or removing people's records (members, roles, invitations) wait for a person, who confirms the processing is allowed.`,
      policy: {
        name: `${short}: a person approves changes to ${term}`,
        description: `Agent changes to members, roles and invitations wait for a person (${short}: ${cite.lawful}).`,
        effect: "require_approval",
        mode: "enforce",
        priority: 210,
        match: { minRisk: "sensitive_write" },
      },
    },
    {
      id: "pd-access",
      title: `Agent access to ${term} is recorded`,
      basis: cite.lawful,
      kind: "policy",
      howCovered:
        "Agents reading people's records are logged as needing approval, so every access is visible. Switch this policy to enforce to hold each access for a person.",
      policy: {
        name: `${short}: agent access to ${term}`,
        description: `Agent reads of people's records are recorded as needing approval (${short}: ${cite.lawful}).`,
        effect: "require_approval",
        mode: "advisory",
        priority: 200,
        match: { tools: PEOPLE_DATA },
      },
    },
  ];
  if (cite.consent) {
    items.push({
      id: "consent",
      title: "Consent",
      basis: cite.consent,
      kind: "manual",
      howCovered:
        "Pristine does not hold consent records. Collect and manage consent in your own systems before agents process that data.",
    });
  }
  items.push(
    {
      id: "security",
      title: `Security safeguards for ${term}`,
      basis: cite.security,
      kind: "setting",
      howCovered:
        "Turns on DLP (secrets, card and ID numbers blocked; personal data held), threat detection, incident containment and suspension of critical-risk agents, and masks personal data sent to AI providers.",
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
      id: "unauthorised",
      title: "Unauthorised tools cannot change data",
      basis: cite.unauthorised,
      kind: "policy",
      howCovered:
        "AI tools and scripts using a person's login instead of an authorised agent key cannot change data.",
      policy: unregisteredReadOnly(
        `${short}: unauthorised tools cannot change data`,
        `${short}: ${cite.unauthorised}`,
      ),
    },
  );
  if (cite.sensitive) {
    items.push({
      id: "sensitive",
      title: "Sensitive data needs a person",
      basis: cite.sensitive,
      kind: "policy",
      howCovered:
        "Agent changes to projects or tasks labelled Confidential or Restricted wait for a person. Label the projects that hold sensitive data.",
      policy: {
        name: `${short}: a person approves changes to labelled data`,
        description: `Agent changes to Confidential or Restricted data wait for a person (${short}: ${cite.sensitive}).`,
        effect: "require_approval",
        mode: "enforce",
        priority: 230,
        match: {
          minRisk: "write",
          classifications: ["confidential", "restricted"],
        },
      },
    });
  }
  items.push(
    {
      id: "rights",
      title: "Requests from individuals",
      basis: cite.rights,
      kind: "built_in",
      howCovered:
        "The activity log shows which agent touched whose data and when, and can be exported to answer requests. Handling the requests themselves is up to you.",
    },
    {
      id: "minimisation",
      title: "Agents keep only the access they need",
      basis: cite.minimisation,
      kind: "built_in",
      howCovered:
        "Each agent's reach map shows access it never used, with one click to remove it; access reviews ask owners to confirm agents regularly.",
    },
  );
  if (cite.records) {
    items.push({
      id: "records",
      title: "Records of what agents process",
      basis: cite.records,
      kind: "built_in",
      howCovered:
        "Every agent action is logged with who decided and why, and can be exported as an evidence pack. The formal record of processing activities is yours to keep; the export feeds it.",
    });
  }
  if (cite.transfer) {
    items.push({
      id: "transfer",
      title: "Transfers to other countries",
      basis: cite.transfer,
      kind: "manual",
      howCovered: `${law.transferNote ?? "Decide which countries your data may go to."} Then set Allowed data regions in Settings and turn on Enforce compliance: AI providers and vendors outside those regions are blocked.`,
    });
  }
  items.push({
    id: "breach",
    title: "Breach notification",
    basis: cite.breach,
    kind: "manual",
    howCovered: `Incidents record what happened and can be exported, and webhooks can alert your team at once. ${law.breachDuty}`,
  });
  return {
    id: law.id,
    name: law.name,
    jurisdiction: law.jurisdiction,
    category: "privacy",
    source: law.source,
    url: law.url,
    scope: law.scope,
    items: [...items, ...(law.extra ?? [])],
  };
}

const PRIVACY_PACKS: RegulationPack[] = [
  privacyPack({
    id: "gdpr",
    name: "GDPR",
    short: "GDPR",
    jurisdiction: "European Union / EEA",
    source: "Regulation (EU) 2016/679 (General Data Protection Regulation)",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    scope:
      "Applies to controllers and processors established in the EU/EEA, and to those elsewhere that offer goods or services to, or monitor, people in the EU/EEA (Art. 3).",
    term: "personal data",
    cite: {
      lawful: "Art. 6 – Lawfulness of processing",
      security: "Art. 32 – Security of processing",
      rights:
        "Art. 15–20 – access, rectification, erasure, restriction, portability",
      minimisation: "Art. 5(1)(b)–(c) – purpose limitation, data minimisation",
      unauthorised:
        "Art. 29 and Art. 32(4) – processing only on the controller's instructions",
      breach: "Art. 33–34 – Notification of a personal data breach",
      transfer: "Art. 44–49 – Transfers to third countries",
      records: "Art. 30 – Records of processing activities",
      sensitive:
        "Art. 9 – Special categories; supports Art. 35 – Data protection impact assessment",
    },
    transferNote:
      "Transfers outside the EEA need an adequacy decision or appropriate safeguards such as standard contractual clauses.",
    breachDuty:
      "Notifying the supervisory authority within 72 hours, and affected people when the risk is high, is up to you.",
    extra: [
      {
        id: "dpia",
        title: "Data protection impact assessment",
        basis: "Art. 35 – Data protection impact assessment",
        kind: "manual",
        howCovered:
          "Carry out the DPIA yourself when processing is likely to be high risk. Pristine supplies evidence for it: each agent's risk factors, reach and activity.",
      },
    ],
  }),
  privacyPack({
    id: "uk-gdpr",
    name: "UK GDPR",
    short: "UK GDPR",
    jurisdiction: "United Kingdom",
    source:
      "UK GDPR (Regulation (EU) 2016/679 as retained in UK law) and the Data Protection Act 2018",
    url: "https://www.legislation.gov.uk/eur/2016/679/contents",
    scope:
      "Applies to controllers and processors established in the UK, and to those elsewhere that offer goods or services to, or monitor, people in the UK.",
    term: "personal data",
    cite: {
      lawful: "UK GDPR Art. 6 – Lawfulness of processing",
      security: "UK GDPR Art. 32 – Security of processing",
      rights:
        "UK GDPR Art. 15–20 – access, rectification, erasure, restriction, portability",
      minimisation:
        "UK GDPR Art. 5(1)(b)–(c) – purpose limitation, data minimisation",
      unauthorised:
        "UK GDPR Art. 29 and Art. 32(4) – processing only on the controller's instructions",
      breach: "UK GDPR Art. 33–34 – Notification of a personal data breach",
      transfer: "UK GDPR Chapter V (Art. 44–49) – International transfers",
      records:
        "UK GDPR Art. 5(2) – Accountability; Art. 30 – Records of processing",
    },
    transferNote:
      "Transfers outside the UK need adequacy regulations or appropriate safeguards such as the International Data Transfer Agreement.",
    breachDuty:
      "Reporting to the ICO within 72 hours, and telling affected people when the risk is high, is up to you.",
  }),
  privacyPack({
    id: "singapore-pdpa",
    name: "Singapore PDPA",
    short: "PDPA",
    jurisdiction: "Singapore",
    source: "Personal Data Protection Act 2012 (Singapore)",
    url: "https://sso.agc.gov.sg/Act/PDPA2012",
    scope:
      "Applies to organisations that collect, use or disclose personal data in Singapore.",
    term: "personal data",
    cite: {
      lawful:
        "Sections 13–15 – Consent obligation; Section 18 – Purpose limitation",
      consent: "Sections 13–15 – Consent; Section 20 – Notification of purpose",
      security: "Section 24 – Protection of personal data",
      rights: "Sections 21–22 – Access and correction",
      minimisation: "Section 18 – Purpose limitation",
      unauthorised:
        "Section 24 – Protection against unauthorised access and use",
      breach: "Part 6A (Sections 26A–26E) – Notification of data breaches",
      transfer: "Section 26 – Transfer of personal data outside Singapore",
    },
    transferNote:
      "Data may leave Singapore only if the recipient gives comparable protection.",
    breachDuty:
      "Assessing the breach and notifying the PDPC within 3 calendar days (and affected people) when it is notifiable is up to you.",
  }),
  privacyPack({
    id: "australia-privacy",
    name: "Australia Privacy Act",
    short: "Privacy Act (APPs)",
    jurisdiction: "Australia",
    source:
      "Privacy Act 1988 (Cth) and the Australian Privacy Principles (Schedule 1)",
    url: "https://www.legislation.gov.au/C2004A03712/latest/text",
    scope:
      "Applies to APP entities: Australian Government agencies and organisations with annual turnover above AUD 3 million, plus some smaller ones (e.g. health service providers).",
    term: "personal information",
    cite: {
      lawful: "APP 3 – Collection; APP 6 – Use or disclosure",
      security: "APP 11 – Security of personal information",
      rights: "APP 12 – Access; APP 13 – Correction",
      minimisation: "APP 3 – collection only where reasonably necessary; APP 6",
      unauthorised:
        "APP 11.1 – protection from unauthorised access, modification or disclosure",
      breach: "Part IIIC – Notifiable Data Breaches scheme",
      transfer: "APP 8 – Cross-border disclosure",
      sensitive: "APP 3.3 – Sensitive information",
    },
    transferNote:
      "Before disclosing overseas, take reasonable steps to make sure the recipient follows the APPs; you stay accountable.",
    breachDuty:
      "Assessing a suspected breach within 30 days and notifying the OAIC and affected people when serious harm is likely is up to you.",
  }),
  privacyPack({
    id: "japan-appi",
    name: "Japan APPI",
    short: "APPI",
    jurisdiction: "Japan",
    source:
      "Act on the Protection of Personal Information (Act No. 57 of 2003)",
    url: "https://www.japaneselawtranslation.go.jp/en/laws/view/4241/en",
    scope:
      "Applies to businesses handling personal information in Japan, and to those abroad handling it in connection with offering goods or services to people in Japan.",
    term: "personal information",
    cite: {
      lawful:
        "Art. 17–18 – Specifying and limiting the purpose of use; Art. 20 – Proper acquisition",
      consent:
        "Art. 20(2) – consent for special care-required personal information; Art. 27 – consent for provision to third parties",
      security:
        "Art. 23 – Security control measures; Art. 24–25 – Supervision of employees and trustees",
      rights: "Art. 33–35 – Disclosure, correction, cessation of use",
      minimisation: "Art. 18 – Restriction due to purpose of use",
      unauthorised: "Art. 23 – Security control measures",
      breach: "Art. 26 – Reporting of leaks",
      transfer: "Art. 28 – Provision to a third party in a foreign country",
    },
    transferNote:
      "Providing data to a third party abroad generally needs the person's consent, an equivalent-protection arrangement or a recognised country.",
    breachDuty:
      "Reporting to the Personal Information Protection Commission and notifying affected people is up to you.",
    extra: [
      {
        id: "third-party",
        title: "Only approved third parties receive data",
        basis: "Art. 27 – Restriction on provision to third parties",
        kind: "setting",
        howCovered:
          "Only third parties you have approved can receive data from your agents; unapproved vendors and AI providers are limited until reviewed.",
        settings: { approvedVendorsOnly: true },
      },
    ],
  }),
  privacyPack({
    id: "brazil-lgpd",
    name: "Brazil LGPD",
    short: "LGPD",
    jurisdiction: "Brazil",
    source: "Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018)",
    url: "https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm",
    scope:
      "Applies to processing carried out in Brazil, of data collected in Brazil, or aimed at offering goods or services to people in Brazil (Art. 3).",
    term: "personal data",
    cite: {
      lawful: "Art. 7 – Legal bases for processing",
      security: "Art. 46 – Security measures",
      rights: "Art. 18 – Rights of the data subject",
      minimisation: "Art. 6(I)–(III) – purpose, adequacy, necessity",
      unauthorised: "Art. 46 – protection from unauthorised access",
      breach: "Art. 48 – Communication of security incidents",
      transfer: "Art. 33 – International transfer of data",
      records: "Art. 37 – Record of processing operations",
      sensitive: "Art. 11 – Sensitive personal data",
    },
    transferNote:
      "International transfers need an adequacy finding, standard contractual clauses or another Art. 33 ground.",
    breachDuty:
      "Telling the ANPD and affected data subjects about incidents that may cause relevant risk or harm is up to you.",
    extra: [
      {
        id: "dpo",
        title: "Data protection officer (encarregado)",
        basis: "Art. 41 – Encarregado",
        kind: "manual",
        howCovered:
          "Appoint an encarregado and publish their contact details. Pristine's compliance report and evidence pack give them the agent records they need.",
      },
    ],
  }),
  privacyPack({
    id: "canada-pipeda",
    name: "Canada PIPEDA",
    short: "PIPEDA",
    jurisdiction: "Canada",
    source:
      "Personal Information Protection and Electronic Documents Act (S.C. 2000, c. 5), Schedule 1 principles",
    url: "https://laws-lois.justice.gc.ca/eng/acts/P-8.6/",
    scope:
      "Applies to private-sector organisations that handle personal information in the course of commercial activity in Canada (provinces with substantially similar laws are covered by those instead). Canada's proposed Artificial Intelligence and Data Act is not law and is not part of this pack.",
    term: "personal information",
    cite: {
      lawful:
        "Principle 4.3 – Consent; Principle 4.5 – Limiting use, disclosure and retention",
      consent: "Principle 4.3 – Consent; Principle 4.2 – Identifying purposes",
      security: "Principle 4.7 – Safeguards",
      rights: "Principle 4.9 – Individual access",
      minimisation:
        "Principle 4.4 – Limiting collection; Principle 4.5 – Limiting use",
      unauthorised:
        "Principle 4.7 – protection against unauthorised access and use",
      breach:
        "Section 10.1 – Breaches of security safeguards; Section 10.3 – Records",
      records: "Principle 4.1 – Accountability",
    },
    breachDuty:
      "Reporting to the Privacy Commissioner and notifying people when there is a real risk of significant harm, and keeping breach records for 24 months, is up to you.",
  }),
  privacyPack({
    id: "korea-pipa",
    name: "South Korea PIPA",
    short: "PIPA",
    jurisdiction: "South Korea",
    source: "Personal Information Protection Act (Republic of Korea)",
    url: "https://www.law.go.kr/LSW/eng/engLsSc.do?menuId=2&query=PERSONAL%20INFORMATION%20PROTECTION%20ACT",
    scope:
      "Applies to personal information controllers that process personal information of people in South Korea.",
    term: "personal information",
    cite: {
      lawful:
        "Art. 15 – Collection and use; Art. 17 – Provision to third parties; Art. 18 – Limits on use beyond the purpose",
      consent:
        "Art. 15 and Art. 17 – consent; Art. 22 – how consent is obtained",
      security: "Art. 29 – Duty of safeguards",
      rights:
        "Art. 35–37 – Access, correction and deletion, suspension of processing",
      minimisation: "Art. 3 – Principles; Art. 16 – Minimum collection",
      unauthorised: "Art. 29 – Duty of safeguards",
      breach: "Art. 34 – Notification of personal information leaks",
      transfer: "Art. 28-8 – Cross-border transfer of personal information",
      sensitive:
        "Art. 23 – Sensitive information; Art. 24 – Unique identification information",
    },
    transferNote:
      "Cross-border transfers generally need the person's separate consent or another Art. 28-8 ground.",
    breachDuty:
      "Notifying affected people and reporting to the Personal Information Protection Commission (within 72 hours) is up to you.",
  }),
];

/* ------------------------------------------------------------------ */
/* US AI disclosure laws: mostly duties Pristine cannot do for you.    */
/* ------------------------------------------------------------------ */

const US_AI_PACKS: RegulationPack[] = [
  {
    id: "nyc-ll144",
    name: "NYC Local Law 144",
    jurisdiction: "New York City, USA",
    category: "ai",
    source:
      "New York City Local Law 144 of 2021 (N.Y.C. Admin. Code § 20-870 et seq.; rules at 6 RCNY § 5-300 et seq.)",
    url: "https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page",
    scope:
      "Applies to employers and employment agencies that use an automated employment decision tool (AEDT) to screen candidates for jobs or employees for promotion in New York City.",
    items: [
      {
        id: "vendor-gate",
        title: "An AEDT is not used until you approve its vendor",
        basis: "§ 20-871(a)(1) – bias audit before use",
        kind: "setting",
        howCovered:
          "Third-party tools are limited until you approve the vendor. Attach the tool's bias audit as evidence on the vendor record before approving it. Pristine cannot check the audit itself.",
        settings: { approvedVendorsOnly: true },
      },
      {
        id: "bias-audit",
        title: "Independent bias audit within the last year",
        basis: "§ 20-871(a)(1) – bias audit",
        kind: "manual",
        howCovered:
          "Have an independent auditor run the bias audit no more than one year before using the tool. Activity exports can supply historical data for the auditor.",
      },
      {
        id: "audit-summary",
        title: "Public summary of the bias audit",
        basis: "§ 20-871(a)(2) – summary of results made publicly available",
        kind: "manual",
        howCovered:
          "Publish the audit summary and the tool's distribution date on your website.",
      },
      {
        id: "candidate-notice",
        title: "Notice to candidates and employees",
        basis:
          "§ 20-871(b)(1)–(2) – notice at least 10 business days before use",
        kind: "manual",
        howCovered:
          "Tell candidates who live in the city that an AEDT will be used and which qualifications it assesses, at least 10 business days before, and let them ask for an alternative.",
      },
      {
        id: "retention-policy",
        title: "Data retention policy available on request",
        basis:
          "§ 20-871(b)(3) – data collected, its source and the retention policy",
        kind: "manual",
        howCovered:
          "Publish, or give within 30 days of a written request, what data the tool collects, where it comes from and how long you keep it.",
      },
      {
        id: "decisions-logged",
        title: "Every agent decision is recorded",
        basis: "Supports § 20-871 – records for bias audits",
        kind: "built_in",
        howCovered:
          "Every agent action is logged with the rule or person that decided it and can be exported.",
      },
    ],
  },
  {
    id: "illinois-aivia",
    name: "Illinois AI Video Interview Act",
    jurisdiction: "Illinois, USA",
    category: "ai",
    source: "Artificial Intelligence Video Interview Act (820 ILCS 42/)",
    url: "https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=4015&ChapterID=68",
    scope:
      "Applies to employers that ask applicants for Illinois-based positions to record video interviews and use AI to analyse them.",
    items: [
      {
        id: "notice-consent",
        title: "Notice, explanation and consent before AI analysis",
        basis:
          "820 ILCS 42/5 – Disclosure of the use of artificial intelligence analysis",
        kind: "manual",
        howCovered:
          "Before the interview, tell the applicant AI may be used, explain how it works and what it evaluates, and get their consent. Pristine does not hold consent records.",
      },
      {
        id: "sharing",
        title: "Videos are shared only with approved parties",
        basis: "820 ILCS 42/10 – Sharing videos limited",
        kind: "setting",
        howCovered:
          "Only third parties you have approved can receive data from your agents, and links to unapproved sites in what agents send are blocked. Sharing only with those whose expertise is needed to evaluate the applicant stays your call.",
        settings: {
          approvedVendorsOnly: true,
          governance: { dlpMode: "enforce" },
        },
        advisorySettings: { governance: { dlpMode: "monitor" } },
      },
      {
        id: "destruction",
        title: "Deletions are confirmed by a person and recorded",
        basis: "820 ILCS 42/15 – Destruction of videos",
        kind: "policy",
        howCovered:
          "Deletes by agents wait for a person and are recorded with who approved them, giving you proof of destruction. Deleting within 30 days of a request, and telling others who hold copies, is up to you.",
        policy: {
          name: "Illinois AIVIA: a person confirms deletions",
          description:
            "Deletes by agents wait for a person and are recorded (820 ILCS 42/15).",
          effect: "require_approval",
          mode: "enforce",
          priority: 220,
          match: { minRisk: "destructive" },
        },
      },
      {
        id: "demographics",
        title: "Demographic reporting",
        basis: "820 ILCS 42/20 – Report of demographic data",
        kind: "manual",
        howCovered:
          "If you rely solely on AI analysis to decide who gets an in-person interview, collect and report the required demographic data each year.",
      },
    ],
  },
  {
    id: "utah-ai",
    name: "Utah AI Policy Act",
    jurisdiction: "Utah, USA",
    category: "ai",
    source:
      "Utah Artificial Intelligence Policy Act (S.B. 149, 2024), as amended in 2025 (S.B. 226, S.B. 332)",
    url: "https://le.utah.gov/~2024/bills/static/SB0149.html",
    scope:
      "Applies to businesses and regulated professionals that use generative AI to interact with people in Utah. It is a disclosure and accountability law.",
    items: [
      {
        id: "disclose-on-request",
        title: "Say it is AI when someone asks",
        basis: "S.B. 149 as amended – disclosure of generative AI on request",
        kind: "manual",
        howCovered:
          "When a person clearly asks whether they are talking to AI, your product must say so clearly. This is done in your own product.",
      },
      {
        id: "regulated-occupations",
        title: "Up-front disclosure in regulated occupations",
        basis:
          "S.B. 149 as amended – regulated occupations, high-risk interactions",
        kind: "manual",
        howCovered:
          "People in regulated occupations (e.g. health, legal, financial) must disclose generative AI at the start of high-risk interactions. This is done in your own product.",
      },
      {
        id: "accountability",
        title: "You answer for what your AI does",
        basis:
          "S.B. 149 – generative AI is not a defence to consumer protection violations",
        kind: "built_in",
        howCovered:
          "Every agent has a named owner and every action it takes is logged with who or what decided it, so you can show what your AI did and why.",
      },
      {
        id: "undeclared",
        title: "Undeclared AI tools cannot change data",
        basis: "Supports accountability under S.B. 149",
        kind: "policy",
        howCovered:
          "AI tools and scripts using a person's login instead of a declared agent key cannot change data, so nothing acts without a named owner.",
        policy: unregisteredReadOnly(
          "Utah AI Policy Act: undeclared AI cannot change data",
          "supports accountability under Utah S.B. 149",
        ),
      },
    ],
  },
];

const byId = new Map(
  [...PRIVACY_PACKS, ...US_AI_PACKS].map((p) => [p.id, p] as const),
);

/** In the order the packs are listed to admins. */
export const MORE_PACKS: RegulationPack[] = [
  "gdpr",
  "uk-gdpr",
  "nyc-ll144",
  "illinois-aivia",
  "utah-ai",
  "singapore-pdpa",
  "australia-privacy",
  "japan-appi",
  "brazil-lgpd",
  "canada-pipeda",
  "korea-pipa",
].map((id) => byId.get(id) as RegulationPack);
