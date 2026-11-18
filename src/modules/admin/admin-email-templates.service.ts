import EmailService from "../../shared/services/email.service.js";
import EmailTemplateModel from "../email-templates/email-template.model.js";
import { DEFAULT_TEMPLATES, findDefault } from "../email-templates/defaults.js";
import {
  baseVars,
  ensureDefaultTemplates,
  getTemplate,
  renderTemplate,
  sampleVars,
} from "../email-templates/email-template.service.js";
import adminUsers, { AdminError, type Actor } from "./admin-users.service.js";

const MAX_HTML = 200_000;
const VAR_NAMES = /\{\{\{?\s*([A-Za-z0-9_]+)\s*\}?\}\}/g;

const row = (t: {
  code: string;
  name: string;
  description: string;
  subject: string;
  html: string;
  variables: Array<{ key: string; description: string; sample: string }>;
  isActive: boolean;
  canDisable?: boolean;
  updatedAt?: Date;
}) => ({
  code: t.code,
  name: t.name,
  description: t.description,
  subject: t.subject,
  html: t.html,
  variables: t.variables.map((v) => ({
    key: v.key,
    description: v.description,
    sample: v.sample,
  })),
  isActive: t.isActive,
  canDisable: t.canDisable !== false,
  updatedAt: t.updatedAt ?? null,
});

/** Names used in a template that its variable list does not offer (they would be sent empty). */
const unknownVariables = (
  subject: string,
  html: string,
  known: Array<{ key: string }>,
): string[] => {
  const allowed = new Set([
    ...known.map((v) => v.key),
    ...Object.keys(baseVars()),
  ]);
  const used = new Set<string>();
  for (const text of [subject, html]) {
    for (const m of text.matchAll(VAR_NAMES)) used.add(m[1]);
  }
  return [...used].filter((name) => !allowed.has(name));
};

const checkDraft = (draft: { subject?: unknown; html?: unknown }) => {
  if (draft.subject !== undefined) {
    if (typeof draft.subject !== "string" || !draft.subject.trim())
      throw new AdminError(400, "The subject cannot be empty.");
    if (draft.subject.length > 200)
      throw new AdminError(400, "The subject can be at most 200 characters.");
  }
  if (draft.html !== undefined) {
    if (typeof draft.html !== "string" || !draft.html.trim())
      throw new AdminError(400, "The email body cannot be empty.");
    if (draft.html.length > MAX_HTML)
      throw new AdminError(400, "The email body is too long.");
    // Email clients drop scripts; refusing them also keeps the preview safe.
    if (/<\s*script/i.test(draft.html))
      throw new AdminError(
        400,
        "The email body must not contain <script> tags.",
      );
  }
};

class AdminEmailTemplatesService {
  public async list() {
    await ensureDefaultTemplates();
    const stored = await EmailTemplateModel.find().lean();
    const order = new Map(DEFAULT_TEMPLATES.map((t, i) => [t.code, i]));
    return stored
      .sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
      .map((t) => row(t));
  }

  public async get(code: string) {
    const tpl = await getTemplate(code);
    if (!tpl) throw new AdminError(404, "Email template not found.");
    return row(tpl);
  }

  public async update(
    actor: Actor,
    code: string,
    body: {
      name?: unknown;
      subject?: unknown;
      html?: unknown;
      isActive?: unknown;
    },
  ) {
    const tpl = await getTemplate(code);
    if (!tpl) throw new AdminError(404, "Email template not found.");
    checkDraft(body);
    const set: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim())
      set.name = body.name.trim().slice(0, 120);
    if (typeof body.subject === "string") set.subject = body.subject.trim();
    if (typeof body.html === "string") set.html = body.html;
    if (typeof body.isActive === "boolean") {
      if (!body.isActive && tpl.canDisable === false)
        throw new AdminError(
          400,
          "This email is needed to sign in, so it cannot be switched off.",
        );
      set.isActive = body.isActive;
    }
    const updated = await EmailTemplateModel.findOneAndUpdate(
      { code: tpl.code },
      { $set: set },
      { new: true },
    );
    await adminUsers.record(
      actor,
      "email-template.update",
      { type: "platform", id: tpl.code, label: tpl.name },
      { fields: Object.keys(set) },
    );
    const result = row(updated!);
    return {
      template: result,
      unknownVariables: unknownVariables(
        result.subject,
        result.html,
        result.variables,
      ),
    };
  }

  public async reset(actor: Actor, code: string) {
    const def = findDefault(code);
    if (!def) throw new AdminError(404, "Email template not found.");
    const tpl = await EmailTemplateModel.findOneAndUpdate(
      { code: def.code },
      { $set: { ...def, isActive: true } },
      { new: true, upsert: true },
    );
    await adminUsers.record(actor, "email-template.reset", {
      type: "platform",
      id: def.code,
      label: def.name,
    });
    return row(tpl);
  }

  /** The draft (or the saved copy) filled with sample values, for the live preview. */
  public async preview(
    code: string,
    draft: { subject?: unknown; html?: unknown },
  ) {
    const tpl = await getTemplate(code);
    if (!tpl) throw new AdminError(404, "Email template not found.");
    checkDraft(draft);
    const subject =
      typeof draft.subject === "string" ? draft.subject : tpl.subject;
    const html = typeof draft.html === "string" ? draft.html : tpl.html;
    const rendered = renderTemplate(
      { subject, html },
      { ...baseVars(), ...sampleVars(tpl.variables) },
    );
    return {
      subject: rendered.subject,
      html: rendered.html,
      unknownVariables: unknownVariables(subject, html, tpl.variables),
    };
  }

  /** Sends the draft with sample values to an address, to see it in a real inbox. */
  public async sendTest(
    actor: Actor,
    code: string,
    body: { to?: unknown; subject?: unknown; html?: unknown },
  ) {
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
      throw new AdminError(
        400,
        "Enter a valid email address to send the test to.",
      );
    if (!EmailService.isConfigured())
      throw new AdminError(
        400,
        "Email is not set up on the server yet. Add BREVO_API_KEY and EMAIL_FROM on the server.",
      );
    const rendered = await this.preview(code, body);
    const sent = await EmailService.sendEmail(
      to,
      `[TEST] ${rendered.subject}`,
      "This is a test of an email template.",
      rendered.html,
    );
    if (!sent)
      throw new AdminError(
        502,
        "The test email could not be sent. Check the server logs.",
      );
    await adminUsers.record(
      actor,
      "email-template.test",
      {
        type: "platform",
        id: code.toUpperCase(),
      },
      { to },
    );
    return { message: `Test email sent to ${to}` };
  }
}

export default new AdminEmailTemplatesService();
