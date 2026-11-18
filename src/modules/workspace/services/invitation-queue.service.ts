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

/** Sends the email a job describes, built from the stored template of that email. */
export const processInvitationJob = async (
  name: string,
  data: InvitationJobData,
): Promise<void> => {
  const { email, projectName, inviterName, token, isNewUser } = data;
  const frontend = (env.FRONTEND_BASE_URL || "").replace(/\/$/, "");

  let ok: boolean;
  if (name === "send-workspace-added-email") {
    ok = await EmailService.sendTemplate(email, "WORKSPACE_ADDED", {
      workspaceName: projectName,
      inviterName,
    });
  } else if (name === "send-invite-email" && token) {
    ok = await EmailService.sendTemplate(email, "PROJECT_INVITATION", {
      projectName,
      inviterName,
      acceptUrl: `${frontend}/accept-invitation?token=${token}`,
      declineUrl: `${env.BACKEND_URL}/api/invitations/reject-public?token=${token}`,
      ctaLabel: isNewUser ? "Create account and join" : "Accept invitation",
      nextStep: isNewUser
        ? "You do not have a Pristine account yet. Open the link, choose your name and a password, and you will be added to the project and its workspace straight away."
        : "Open the link and accept, and you will be added to the project and its workspace.",
      expiryDays: "14",
    });
  } else if (name === "send-added-directly-email") {
    ok = await EmailService.sendTemplate(email, "PROJECT_ADDED", {
      projectName,
      inviterName,
    });
  } else {
    return;
  }
  if (!ok) throw new Error(`Failed to send the ${name} email to ${email}`);
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
