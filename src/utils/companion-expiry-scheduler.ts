import cron from "node-cron";
import logger from "../lib/logger.js";
import { runExclusive } from "./job-lock.js";
import authService from "../modules/auth/services/auth.service.js";

const CRON_EXPRESSION = "*/30 * * * *";

const sweep = async (): Promise<void> => {
  await runExclusive("companion-expiry", 25 * 60 * 1000, async () => {
    try {
      const removed = await authService.removeExpiredCompanionDevices();
      if (removed > 0) {
        logger.info(
          `Removed ${removed} companion device(s) whose month ended and revoked their tokens`,
        );
      }
    } catch (error) {
      logger.error("Companion expiry job failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
};

/** Companion devices are paired for one month; this removes the ones that ran out and revokes their tokens. */
export const scheduleCompanionExpiryJob = (): cron.ScheduledTask => {
  logger.info("Scheduling companion device expiry job", {
    expression: CRON_EXPRESSION,
  });
  // Once shortly after start (the database connects after the schedulers are set up), then every 30 minutes.
  setTimeout(() => void sweep(), 20_000).unref();
  return cron.schedule(CRON_EXPRESSION, sweep);
};
