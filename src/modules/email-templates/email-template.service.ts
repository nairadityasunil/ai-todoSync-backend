import env from "../../config/env.js";
import logger from "../../lib/logger.js";
import EmailTemplateModel, {
  type ITemplateVariable,
} from "./email-template.model.js";
import { DEFAULT_TEMPLATES, findDefault } from "./defaults.js";

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

/** A readable plain-text version of an HTML email, for clients that do not show HTML. */
export const htmlToText = (html: string): string =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && text !== href ? `${text} (${href})` : href;
      },
    )
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const VAR_RE =
  /\{\{\{\s*([A-Za-z0-9_]+)\s*\}\}\}|\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Fills {{name}} placeholders. Unknown names become empty. In an HTML body values are escaped, so a project name
 * like <b>x</b> cannot inject markup. {{{name}}} inserts a value as it is: only for variables the app builds
 * itself from escaped parts (for example a list of tasks), never for anything a person typed.
 */
export const renderString = (
  template: string,
  vars: Record<string, string>,
  escape: boolean,
  rawKeys: ReadonlySet<string> = RAW_KEYS,
): string =>
  template.replace(
    VAR_RE,
    (_m, rawKey: string | undefined, key: string | undefined) => {
      if (rawKey) {
        const value = vars[rawKey] ?? "";
        return rawKeys.has(rawKey) ? value : escape ? escapeHtml(value) : value;
      }
      const value = vars[key as string] ?? "";
      return escape ? escapeHtml(value) : value;
    },
  );

/** Variables the app fills with markup it built itself. */
const RAW_KEYS: ReadonlySet<string> = new Set(["taskListHtml"]);

export const sampleVars = (
  variables: ITemplateVariable[],
): Record<string, string> =>
  Object.fromEntries(variables.map((v) => [v.key, v.sample ?? ""]));

export const baseVars = (): Record<string, string> => {
  const websiteUrl = (env.FRONTEND_BASE_URL || "").replace(/\/$/, "");
  return {
    appName: "Pristine",
    websiteUrl,
    dashboardUrl: `${websiteUrl}/dashboard`,
  };
};

/** Inserts any default template missing from the database. Never overwrites one an admin edited. */
export const ensureDefaultTemplates = async (): Promise<number> => {
  let added = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const result = await EmailTemplateModel.updateOne(
      { code: t.code },
      { $setOnInsert: { ...t, isActive: true } },
      { upsert: true },
    );
    if (result.upsertedCount) added += 1;
  }
  return added;
};

export const getTemplate = async (code: string) => {
  const key = code.toUpperCase();
  const existing = await EmailTemplateModel.findOne({ code: key });
  if (existing) return existing;
  const def = findDefault(key);
  if (!def) return null;
  return EmailTemplateModel.findOneAndUpdate(
    { code: key },
    { $setOnInsert: { ...def, isActive: true } },
    { upsert: true, new: true },
  );
};

export const renderTemplate = (
  tpl: { subject: string; html: string },
  vars: Record<string, string>,
): RenderedMail => {
  const html = renderString(tpl.html, vars, true);
  return {
    // The subject is a mail header, not HTML: no escaping, and never a line break.
    subject: renderString(tpl.subject, vars, false)
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 200),
    html,
    text: htmlToText(html),
  };
};

/**
 * Renders a stored template with the given values. Returns null when an admin switched that email off.
 * Emails people need to sign in (canDisable false) are always rendered.
 */
export const renderMail = async (
  code: string,
  vars: Record<string, string>,
  opts: { ignoreActive?: boolean } = {},
): Promise<RenderedMail | null> => {
  const tpl = await getTemplate(code);
  if (!tpl) throw new Error(`Email template ${code} not found`);
  if (!tpl.isActive && tpl.canDisable !== false && !opts.ignoreActive) {
    logger.info(`Email template ${code} is switched off; not sending`);
    return null;
  }
  return renderTemplate(tpl, { ...baseVars(), ...vars });
};
