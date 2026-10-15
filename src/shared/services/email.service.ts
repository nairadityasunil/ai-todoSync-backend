import nodemailer from "nodemailer";
import env from "../../config/env.js";
import logger from "../../lib/logger.js";

export class EmailServiceImpl {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT
      ? Number(process.env.SMTP_PORT)
      : 587;
    const smtpSecure = process.env.SMTP_SECURE === "true";

    if (smtpHost && env.SMTP_USER && env.SMTP_PASS) {
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
        "SMTP configuration missing. EmailService initialized in mock/log mode.",
      );
    }
  }

  public async sendEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<boolean> {
    if (!this.transporter) {
      logger.info(
        `[MOCK EMAIL] To: ${to} | Subject: ${subject} | Text: ${text}`,
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

  public async sendOtpEmail(
    to: string,
    otp: string,
    type: "2fa" | "forgot_password" | string,
  ): Promise<boolean> {
    const subject =
      type === "2fa" ? "Your 2FA Verification Code" : "Your Password Reset OTP";
    const text = `Your OTP code is: ${otp}`;
    const html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>${subject}</h2>
        <p>Your verification code is: <strong style="font-size: 20px;">${otp}</strong></p>
      </div>
    `;
    return this.sendEmail(to, subject, text, html);
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
