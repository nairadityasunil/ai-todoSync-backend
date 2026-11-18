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

const esc = (v: string): string =>
  String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sends the email a job describes. Used by the worker, and directly when the queue is not reachable. */
export const processInvitationJob = async (
  name: string,
  data: InvitationJobData,
): Promise<void> => {
  const { email, projectName, inviterName, token, isNewUser } = data;
  const job = { name };

  if (job.name === "send-workspace-added-email") {
    const dashboardLink = `${env.FRONTEND_BASE_URL}/dashboard`;
    const workspace = esc(projectName);
    const by = esc(inviterName);
    const subject = `You have been added to the workspace: ${projectName}`;
    const text = `Hello,\n\n${inviterName} added you to the workspace "${projectName}" on Pristine.\n\nOpen your dashboard:\n${dashboardLink}`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px;border:1px solid #e1e7e3;border-radius:16px;color:#1c2d27"><div style="text-align:center;font-weight:900;letter-spacing:.25em;margin-bottom:24px">PRISTINE</div><h1 style="font-size:20px;text-align:center;margin:0 0 8px">You are now in a workspace</h1><p style="text-align:center;color:#52635c;font-size:14px;margin:0 0 24px"><strong>${by}</strong> added you to <strong>${workspace}</strong>.</p><p style="text-align:center;margin:0 0 24px"><a href="${dashboardLink}" style="display:inline-block;background:#1c2d27;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px">Open dashboard</a></p><p style="font-size:11px;color:#84998e;text-align:center;margin:0">Sent to ${esc(email)}.</p></div>`;
    if (!(await EmailService.sendEmail(email, subject, text, html))) {
      throw new Error(`Failed to send workspace email to ${email}`);
    }
  } else if (job.name === "send-invite-email" && token) {
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
                <div class="card-value">${esc(projectName)}</div>
                <div style="font-size: 12px; color: #52635c; margin-top: 8px;">
                  Invited by <strong>${esc(inviterName)}</strong> to collaborate as a team member.
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
                This invitation was sent to <span style="color: #1c2d27; font-weight: 600;">${esc(email)}</span>.<br>
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
                <div class="card-value">${esc(projectName)}</div>
                <div style="font-size: 12px; color: #52635c; margin-top: 8px;">
                  Added by <strong>${esc(inviterName)}</strong>. You can now access and participate in this workspace immediately.
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
                This notification was sent to <span style="color: #1c2d27; font-weight: 600;">${esc(email)}</span>.<br>
                <a href="${dashboardLink}">Go to Dashboard</a>
              </div>
            </div>
          </body>
          </html>
        `;

    const result = await EmailService.sendEmail(email, subject, text, html);
    if (!result) {
      throw new Error(`Failed to send added notification email to ${email}`);
    }
  }
};

/**
 * Queues an invitation email. When the queue (Redis) cannot be reached the email is sent straight away, so an
 * invitation is never saved without the person hearing about it. Never throws: the invite itself has succeeded.
 */
export const enqueueInvitationMail = async (
  name:
    | "send-invite-email"
    | "send-added-directly-email"
    | "send-workspace-added-email",
  data: InvitationJobData,
): Promise<void> => {
  try {
    await Promise.race([
      invitationQueue.add(name, data, {
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("queue timed out")), 3000),
      ),
    ]);
  } catch (queueError) {
    logger.warn(
      `Invitation queue unavailable (${(queueError as Error).message}); sending the email directly to ${data.email}`,
    );
    try {
      await processInvitationJob(name, data);
    } catch (sendError) {
      logger.error(
        `Could not send the ${name} email to ${data.email}`,
        sendError as Error,
      );
    }
  }
};

// Create Worker
export const startInvitationWorker = () => {
  const worker = new Worker(
    "invitations",
    async (job: Job<InvitationJobData>) =>
      processInvitationJob(job.name, job.data),
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
