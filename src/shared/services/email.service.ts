import nodemailer from "nodemailer";
import env from "../../config/env.js";
import logger from "../../lib/logger.js";
import { renderMail } from "../../modules/email-templates/email-template.service.js";

export class EmailServiceImpl {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT
      ? Number(process.env.SMTP_PORT)
      : 587;
    const smtpSecure = process.env.SMTP_SECURE === "true";

    if (env.BREVO_API_KEY) {
      logger.info(
        `[mail] mode=brevo-api from=${env.SMTP_FROM ?? "(not set: set EMAIL_FROM to a sender verified in Brevo)"}`,
      );
    } else if (smtpHost && env.SMTP_USER && env.SMTP_PASS) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
      });
    } else {
      logger.warn(
        "No BREVO_API_KEY and no SMTP configuration: emails will only be logged, not sent.",
      );
    }
  }

  /** "Name <a@b.com>" or "a@b.com" into the parts Brevo wants. */
  private parseSender(): { name?: string; email: string } {
    const raw = env.SMTP_FROM || env.SMTP_USER || "no-reply@synctodo.com";
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    return m
      ? { name: m[1].trim() || undefined, email: m[2].trim() }
      : { email: raw.trim() };
  }

  /**
   * Sends through Brevo's HTTPS API (works where SMTP ports are blocked, such as Render's free plan),
   * retrying on network errors, 429 and 5xx.
   */
  private async sendViaBrevo(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<boolean> {
    const sender = this.parseSender();
    const body = JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    });
    let lastError = "Unknown error";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(
          process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email",
          {
            method: "POST",
            headers: {
              "api-key": env.BREVO_API_KEY as string,
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
            signal: AbortSignal.timeout(15_000),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          messageId?: string;
          message?: string;
        };
        if (res.ok) {
          logger.info(
            `[mail] Brevo accepted "${subject}" for ${to} (messageId ${data.messageId ?? "n/a"})`,
          );
          return true;
        }
        lastError = `Brevo API ${res.status}: ${data.message ?? res.statusText}`;
        if (!(res.status === 429 || res.status >= 500)) break;
      } catch (error) {
        lastError = `Could not reach Brevo: ${(error as Error).message}`;
      }
      if (attempt < 3)
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    logger.error(`[mail] Brevo REFUSED "${subject}" for ${to}: ${lastError}`);
    return false;
  }

  /** True when emails really leave the server (a Brevo key or SMTP login is set). */
  public isConfigured(): boolean {
    return Boolean(env.BREVO_API_KEY) || this.transporter !== null;
  }

  public async sendEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<boolean> {
    if (env.BREVO_API_KEY) {
      return this.sendViaBrevo(to, subject, text, html || text);
    }

    if (!this.transporter) {
      logger.warn(
        `[mail] NOT SENT to ${to}: no BREVO_API_KEY and no SMTP settings. [MOCK EMAIL] Subject: ${subject} | Text: ${text}`,
      );
      return true;
    }

    try {
      await this.transporter.sendMail({
        from: env.SMTP_FROM || `"Sync Todo" <no-reply@synctodo.com>`,
        to,
        subject,
        text,
        html: html || text,
      });
      logger.info(`Email sent successfully to ${to}`);
      return true;
    } catch (error) {
      logger.error("Failed to send email", error as Error);
      return false;
    }
  }

  /**
   * Sends the email built from a stored template (edited by platform admins). When the template is switched off
   * nothing is sent and this still counts as success: the email was turned off on purpose.
   */
  public async sendTemplate(
    to: string,
    code: string,
    vars: Record<string, string>,
  ): Promise<boolean> {
    const mail = await renderMail(code, { inviteeEmail: to, ...vars });
    if (mail == null) return true;
    return this.sendEmail(to, mail.subject, mail.text, mail.html);
  }

  public async sendOtpEmail(
    to: string,
    otp: string,
    type: "2fa" | "forgot_password" | string,
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      type === "2fa" ? "LOGIN_2FA_CODE" : "PASSWORD_RESET_CODE",
      { code: otp },
    );
  }

  public async sendInvitationEmail(
    to: string,
    inviterName: string,
    workspaceName: string,
    invitationToken: string,
  ): Promise<boolean> {
    const clientUrl = env.FRONTEND_BASE_URL || "http://localhost:5173";
    const inviteUrl = `${clientUrl}/accept-invitation?token=${invitationToken}`;
    const subject = `${inviterName} invited you to join ${workspaceName} on Sync Todo`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #4f46e5;">You've been invited!</h2>
        <p><strong>${inviterName}</strong> has invited you to join the workspace <strong>${workspaceName}</strong> on Sync Todo.</p>
        <div style="margin: 30px 0;">
          <a href="${inviteUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Accept Invitation</a>
        </div>
        <p style="color: #6b7280; font-size: 14px;">Or copy and paste this link into your browser:<br/><a href="${inviteUrl}">${inviteUrl}</a></p>
      </div>
    `;
    const text = `${inviterName} invited you to join ${workspaceName} on Sync Todo: ${inviteUrl}`;

    return this.sendEmail(to, subject, text, html);
  }
}

export const EmailService = new EmailServiceImpl();
export default EmailService;
