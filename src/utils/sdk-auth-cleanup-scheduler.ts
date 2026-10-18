import cron from "node-cron";
import logger from "../lib/logger.js";
import { runExclusive } from "./job-lock.js";
import { SdkAuthService } from "../modules/sdk/services/sdkAuth.service.js";

const CRON_EXPRESSION = "*/10 * * * *";

export const scheduleSdkAuthCleanupJob = (): cron.ScheduledTask => {
  logger.info("Scheduling SDK Auth cleanup job", {
    expression: CRON_EXPRESSION,
  });

  return cron.schedule(CRON_EXPRESSION, async () => {
    await runExclusive("sdk-auth-cleanup", 540000, async () => {
      try {
        const stats = await SdkAuthService.runCleanupJob();
        if (stats.deletedSessions > 0 || stats.deletedNonces > 0) {
          logger.info("SDK Auth cleanup job completed successfully", stats);
        }
      } catch (error) {
        logger.error("SDK Auth cleanup job failed", {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });
  });
};
