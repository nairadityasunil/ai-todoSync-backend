import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
import env from "../../../config/env.js";
import { EmailService } from "../../../shared/services/email.service.js";
import logger from "../../../lib/logger.js";

// Initialize Redis connection
const connection = new IORedis.default(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const invitationQueue = new Queue("invitations", {
  connection: connection as any,
});

export interface InvitationJobData {
  email: string;
  projectName: string;
  inviterName: string;
  token?: string;
  /** The invited email has no Pristine account yet. */
  isNewUser?: boolean;
}

// Create Worker
export const startInvitationWorker = () => {
  const worker = new Worker(
    "invitations",
    async (job: Job<InvitationJobData>) => {
      const { email, projectName, inviterName, token, isNewUser } = job.data;

      if (job.name === "send-invite-email" && token) {
        const acceptLink = `${env.FRONTEND_BASE_URL}/accept-invitation?token=${token}`;
        const rejectLink = `${env.BACKEND_URL}/api/invitations/reject-public?token=${token}`;
        const subject = `You have been invited to join project: ${projectName}`;
        const nextStep = isNewUser
          ? "You do not have a Pristine account yet. Open the link, choose your name and a password, and you will be added to the project and its workspace straight away."
          : "Open the link and accept, and you will be added to the project and its workspace.";
        const text = `Hello,\n\nYou have been invited to join the project "${projectName}" on Pristine by ${inviterName}.\n\n${nextStep}\n\n${isNewUser ? "Create your account and join" : "Accept the invitation"}:\n${acceptLink}\n\nDecline the invitation:\n${rejectLink}\n\nThis invitation expires in 14 days.`;
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>Join Pristine Project</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8faf9; margin: 0; padding: 40px 0; -webkit-font-smoothing: antialiased; }
              .container { max-width: 500px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e1e7e3; border-radius: 20px; padding: 40px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.01); }
              .logo { text-align: center; margin-bottom: 30px; }
              .logo-text { font-size: 18px; font-weight: 900; letter-spacing: 0.25em; color: #1c2d27; display: inline-block; }
              .title { font-size: 22px; font-weight: 800; color: #1c2d27; text-align: center; margin-top: 0; margin-bottom: 10px; }
              .subtitle { font-size: 14px; color: #52635c; text-align: center; margin-bottom: 30px; }
              .card { background-color: #f3f6f4; border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 30px; border: 1px solid #e1e7e3; }
              .card-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #52635c; margin-bottom: 4px; display: block; }
              .card-value { font-size: 18px; font-weight: 700; color: #1c2d27; margin-bottom: 8px; }
              .btn-row { display: flex; gap: 12px; justify-content: center; margin-bottom: 30px; flex-wrap: wrap; }
              .btn-accept { display: inline-block; background-color: #1c2d27; color: #ffffff !important; padding: 14px 28px; font-weight: 700; text-decoration: none; border-radius: 12px; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; box-shadow: 0 4px 12px rgba(28, 45, 39, 0.15); }
              .btn-decline { display: inline-block; background-color: #ffffff; color: #52635c !important; padding: 14px 28px; font-weight: 700; text-decoration: none; border-radius: 12px; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; border: 1.5px solid #d1dbd4; }
              .divider { height: 1px; background-color: #e1e7e3; margin: 30px 0; }
              .footer { font-size: 11px; color: #84998e; text-align: center; line-height: 1.6; }
              .footer a { color: #1c2d27; text-decoration: none; font-weight: 600; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="logo">
                <span class="logo-text">PRISTINE</span>
              </div>
              
              <h1 class="title">Project Invitation</h1>
              <p class="subtitle">You have been invited to join a collaborative space.</p>
              
              <div class="card">
                <span class="card-label">Project Workspace</span>
                <div class="card-value">${projectName}</div>
                <div style="font-size: 12px; color: #52635c; margin-top: 8px;">
                  Invited by <strong>${inviterName}</strong> to collaborate as a team member.
                </div>
              </div>
              
              <div class="btn-row">
                <a href="${acceptLink}" class="btn-accept" style="color: #ffffff;">${isNewUser ? "Create account and join" : "Accept Invitation"}</a>
                <a href="${rejectLink}" class="btn-decline" style="color: #52635c;">Decline</a>
              </div>
              
              <p style="font-size: 13px; color: #52635c; line-height: 1.6; text-align: center; margin-bottom: 20px;">
                ${nextStep}
              </p>
              
              <div class="divider"></div>
              
              <div class="footer">
                This invitation was sent to <span style="color: #1c2d27; font-weight: 600;">${email}</span>.<br>
                If you did not expect this, you can safely ignore or decline this email.
              </div>
            </div>
          </body>
          </html>
        `;

        const result = await EmailService.sendEmail(email, subject, text, html);
        if (!result) {
          throw new Error(`Failed to send invitation email to ${email}`);
        }
      } else if (job.name === "send-added-directly-email") {
        const dashboardLink = `${env.FRONTEND_BASE_URL}/dashboard`;
        const subject = `You have been added to project: ${projectName}`;
        const text = `Hello,\n\nYou have been added directly to the project "${projectName}" on Pristine by ${inviterName}.\n\nClick the link below to access your dashboard:\n\n${dashboardLink}`;
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>Added to Pristine Project</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8faf9; margin: 0; padding: 40px 0; -webkit-font-smoothing: antialiased; }
              .container { max-width: 500px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e1e7e3; border-radius: 20px; padding: 40px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.01); }
              .logo { text-align: center; margin-bottom: 30px; }
              .logo-text { font-size: 18px; font-weight: 900; letter-spacing: 0.25em; color: #1c2d27; display: inline-block; }
              .title { font-size: 22px; font-weight: 800; color: #1c2d27; text-align: center; margin-top: 0; margin-bottom: 10px; }
              .subtitle { font-size: 14px; color: #52635c; text-align: center; margin-bottom: 30px; }
              .card { background-color: #f3f6f4; border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 30px; border: 1px solid #e1e7e3; }
              .card-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #52635c; margin-bottom: 4px; display: block; }
              .card-value { font-size: 18px; font-weight: 700; color: #1c2d27; margin-bottom: 8px; }
              .btn-container { text-align: center; margin-bottom: 30px; }
              .btn { display: inline-block; background-color: #1c2d27; color: #ffffff !important; padding: 14px 28px; font-weight: 700; text-decoration: none; border-radius: 12px; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; box-shadow: 0 4px 12px rgba(28, 45, 39, 0.15); }
              .divider { height: 1px; background-color: #e1e7e3; margin: 30px 0; }
              .footer { font-size: 11px; color: #84998e; text-align: center; line-height: 1.6; }
              .footer a { color: #1c2d27; text-decoration: none; font-weight: 600; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="logo">
                <span class="logo-text">PRISTINE</span>
              </div>
              
              <h1 class="title">Workspace Access Granted</h1>
              <p class="subtitle">You have been added directly to a project workspace.</p>
              
              <div class="card">
                <span class="card-label">Project Workspace</span>
                <div class="card-value">${projectName}</div>
                <div style="font-size: 12px; color: #52635c; margin-top: 8px;">
                  Added by <strong>${inviterName}</strong>. You can now access and participate in this workspace immediately.
                </div>
              </div>
              
              <div class="btn-container">
                <a href="${dashboardLink}" class="btn" style="color: #ffffff;">Go to Dashboard</a>
              </div>
              
              <p style="font-size: 13px; color: #52635c; line-height: 1.6; text-align: center; margin-bottom: 20px;">
                Since you already have a Pristine account, we've set up your permissions automatically.
              </p>
              
              <div class="divider"></div>
              
              <div class="footer">
                This notification was sent to <span style="color: #1c2d27; font-weight: 600;">${email}</span>.<br>
                <a href="${dashboardLink}">Go to Dashboard</a>
              </div>
            </div>
          </body>
          </html>
        `;

        const result = await EmailService.sendEmail(email, subject, text, html);
        if (!result) {
          throw new Error(
            `Failed to send added notification email to ${email}`,
          );
        }
      }
    },
    { connection: connection as any },
  );

  worker.on("completed", (job) => {
    logger.info(`Invitation job ${job.id} completed successfully`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`Invitation job ${job?.id} failed`, err);
  });

  return worker;
};
