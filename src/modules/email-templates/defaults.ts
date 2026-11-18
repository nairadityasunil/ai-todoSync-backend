/**
 * Default email templates, written to the database on first use or by `npm run seed:email-templates`.
 * After that the copy in the database is the source of truth and platform admins edit it in the admin panel;
 * "Reset to default" restores these. Variables are written {{name}} and are HTML-escaped when the email is built.
 */
import type { ITemplateVariable } from "./email-template.model.js";

export interface DefaultTemplate {
  code: string;
  name: string;
  description: string;
  subject: string;
  html: string;
  variables: ITemplateVariable[];
  canDisable: boolean;
}

const wrap = (
  title: string,
  inner: string,
  preheader = "",
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f8faf9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c2d27;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8faf9;padding:36px 12px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e1e7e3;border-radius:20px;">
        <tr><td style="padding:36px 36px 8px;text-align:center;">
          <span style="font-size:18px;font-weight:900;letter-spacing:.25em;color:#1c2d27;">{{appName}}</span>
        </td></tr>
        <tr><td style="padding:12px 36px 32px;">
          <h1 style="margin:14px 0 10px;font-size:22px;line-height:1.3;text-align:center;color:#1c2d27;">${title}</h1>
${inner}
        </td></tr>
        <tr><td style="padding:0 36px 30px;text-align:center;border-top:1px solid #e1e7e3;">
          <p style="margin:22px 0 0;font-size:11px;line-height:1.6;color:#84998e;">Sent by {{appName}} &middot; <a href="{{websiteUrl}}" style="color:#1c2d27;text-decoration:none;font-weight:600;">{{websiteUrl}}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const button = (href: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto;"><tr><td style="border-radius:12px;background:#1c2d27;"><a href="${href}" style="display:inline-block;padding:14px 28px;font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:12px;">${label}</a></td></tr></table>`;

const card = (label: string, value: string, note: string): string =>
  `<div style="margin:22px 0;padding:22px;background:#f3f6f4;border:1px solid #e1e7e3;border-radius:16px;text-align:center;">
            <div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#52635c;">${label}</div>
            <div style="margin:6px 0 8px;font-size:18px;font-weight:700;color:#1c2d27;">${value}</div>
            <div style="font-size:12px;color:#52635c;">${note}</div>
          </div>`;

const para = (text: string): string =>
  `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:#52635c;text-align:center;">${text}</p>`;

const common: ITemplateVariable[] = [
  { key: "appName", description: "Name of the app", sample: "Pristine" },
  {
    key: "websiteUrl",
    description: "Address of the app",
    sample: "https://app.example.com",
  },
  {
    key: "dashboardUrl",
    description: "Link to the dashboard",
    sample: "https://app.example.com/dashboard",
  },
];

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    code: "PROJECT_INVITATION",
    name: "Project invitation",
    description:
      "Sent when someone is invited to a project. It has links to accept or decline; people without an account create one first.",
    subject: "You have been invited to join project: {{projectName}}",
    canDisable: true,
    variables: [
      {
        key: "projectName",
        description: "Name of the project",
        sample: "Website redesign",
      },
      {
        key: "inviterName",
        description: "Who sent the invitation",
        sample: "Aditya Nair",
      },
      {
        key: "inviteeEmail",
        description: "The invited person's email address",
        sample: "new.person@example.com",
      },
      {
        key: "acceptUrl",
        description:
          "Link that accepts the invitation (or creates the account first)",
        sample: "https://app.example.com/accept-invitation?token=abc123",
      },
      {
        key: "declineUrl",
        description: "Link that declines the invitation",
        sample:
          "https://api.example.com/api/invitations/reject-public?token=abc123",
      },
      {
        key: "ctaLabel",
        description:
          "Button text: 'Accept invitation' or 'Create account and join'",
        sample: "Accept invitation",
      },
      {
        key: "nextStep",
        description:
          "One sentence about what happens next, different for people with and without an account",
        sample:
          "Open the link and accept, and you will be added to the project and its workspace.",
      },
      {
        key: "expiryDays",
        description: "How many days the invitation stays valid",
        sample: "14",
      },
      ...common,
    ],
    html: wrap(
      "Project invitation",
      `          ${para("You have been invited to join a collaborative space.")}
          ${card("Project", "{{projectName}}", "Invited by <strong>{{inviterName}}</strong> to collaborate as a team member.")}
          ${button("{{acceptUrl}}", "{{ctaLabel}}")}
          ${para('<a href="{{declineUrl}}" style="color:#52635c;">Decline the invitation</a>')}
          ${para("{{nextStep}}")}
          <p style="margin:22px 0 0;font-size:11px;line-height:1.6;color:#84998e;text-align:center;">This invitation was sent to {{inviteeEmail}} and expires in {{expiryDays}} days. If you did not expect it, you can safely ignore it or decline.</p>`,
      "{{inviterName}} invited you to {{projectName}}",
    ),
  },
  {
    code: "PROJECT_ADDED",
    name: "Added to a project",
    description: "Sent to someone who is added straight to a project.",
    subject: "You have been added to project: {{projectName}}",
    canDisable: true,
    variables: [
      {
        key: "projectName",
        description: "Name of the project",
        sample: "Website redesign",
      },
      {
        key: "inviterName",
        description: "Who added them",
        sample: "Aditya Nair",
      },
      {
        key: "inviteeEmail",
        description: "The person's email address",
        sample: "person@example.com",
      },
      ...common,
    ],
    html: wrap(
      "You are in a new project",
      `          ${para("You have been added directly to a project workspace.")}
          ${card("Project", "{{projectName}}", "Added by <strong>{{inviterName}}</strong>. You can use it right away.")}
          ${button("{{dashboardUrl}}", "Go to dashboard")}
          <p style="margin:22px 0 0;font-size:11px;line-height:1.6;color:#84998e;text-align:center;">Sent to {{inviteeEmail}}.</p>`,
      "{{inviterName}} added you to {{projectName}}",
    ),
  },
  {
    code: "WORKSPACE_ADDED",
    name: "Added to a workspace",
    description: "Sent to someone who is added to a workspace.",
    subject: "You have been added to the workspace: {{workspaceName}}",
    canDisable: true,
    variables: [
      {
        key: "workspaceName",
        description: "Name of the workspace",
        sample: "Aditya's workspace",
      },
      {
        key: "inviterName",
        description: "Who added them",
        sample: "Aditya Nair",
      },
      {
        key: "inviteeEmail",
        description: "The person's email address",
        sample: "person@example.com",
      },
      ...common,
    ],
    html: wrap(
      "You are now in a workspace",
      `          ${para("<strong>{{inviterName}}</strong> added you to <strong>{{workspaceName}}</strong>.")}
          ${button("{{dashboardUrl}}", "Open dashboard")}
          <p style="margin:22px 0 0;font-size:11px;line-height:1.6;color:#84998e;text-align:center;">Sent to {{inviteeEmail}}.</p>`,
      "{{inviterName}} added you to {{workspaceName}}",
    ),
  },
  {
    code: "TASK_ASSIGNED",
    name: "Task assigned",
    description: "Sent when someone assigns a task (or several) to a person.",
    subject: "{{inviterName}} assigned you {{taskWord}}{{inProject}}",
    canDisable: true,
    variables: [
      {
        key: "assigneeName",
        description: "Who the task is assigned to",
        sample: "Ravi",
      },
      {
        key: "inviterName",
        description: "Who assigned it",
        sample: "Aditya Nair",
      },
      {
        key: "taskWord",
        description: "'a task' or '3 tasks'",
        sample: "a task",
      },
      {
        key: "inProject",
        description: "' in <project>' or empty",
        sample: " in Website redesign",
      },
      {
        key: "projectName",
        description: "Project name, or empty",
        sample: "Website redesign",
      },
      { key: "taskCount", description: "How many tasks", sample: "1" },
      {
        key: "taskListHtml",
        description:
          "The list of tasks, with links (use three braces: {{{taskListHtml}}})",
        sample:
          '<ul style="padding-left:18px;margin:0"><li><a href="#">Draft the landing page</a> · high priority · due 2026-12-01</li></ul>',
      },
      ...common,
    ],
    html: wrap(
      "Assigned to you",
      `          ${para("Hello {{assigneeName}}, <strong>{{inviterName}}</strong> assigned you {{taskWord}}{{inProject}}.")}
          <div style="margin:18px 0;font-size:14px;line-height:1.7;color:#1c2d27;">{{{taskListHtml}}}</div>
          ${button("{{dashboardUrl}}", "Open dashboard")}`,
      "{{inviterName}} assigned you {{taskWord}}",
    ),
  },
  {
    code: "LOGIN_2FA_CODE",
    name: "Sign-in verification code",
    description:
      "The code sent when someone with two-step sign-in logs in. It cannot be switched off.",
    subject: "Your verification code",
    canDisable: false,
    variables: [
      { key: "code", description: "The one-time code", sample: "482913" },
      ...common,
    ],
    html: wrap(
      "Your verification code",
      `          ${para("Use this code to finish signing in.")}
          <div style="margin:22px 0;padding:20px;background:#f3f6f4;border:1px solid #e1e7e3;border-radius:16px;text-align:center;font-size:30px;font-weight:800;letter-spacing:.3em;color:#1c2d27;">{{code}}</div>
          ${para("If you did not try to sign in, you can ignore this email.")}`,
      "Your verification code is {{code}}",
    ),
  },
  {
    code: "PASSWORD_RESET_CODE",
    name: "Password reset code",
    description:
      "The code sent when someone asks to reset their password. It cannot be switched off.",
    subject: "Your password reset code",
    canDisable: false,
    variables: [
      { key: "code", description: "The one-time code", sample: "739204" },
      ...common,
    ],
    html: wrap(
      "Reset your password",
      `          ${para("Use this code to choose a new password.")}
          <div style="margin:22px 0;padding:20px;background:#f3f6f4;border:1px solid #e1e7e3;border-radius:16px;text-align:center;font-size:30px;font-weight:800;letter-spacing:.3em;color:#1c2d27;">{{code}}</div>
          ${para("If you did not ask for this, you can ignore this email: your password has not changed.")}`,
      "Your password reset code is {{code}}",
    ),
  },
];

export const findDefault = (code: string): DefaultTemplate | undefined =>
  DEFAULT_TEMPLATES.find((t) => t.code === code.toUpperCase());
