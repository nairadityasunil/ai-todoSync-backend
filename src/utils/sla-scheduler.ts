import cron from "node-cron";

import logger from "../lib/logger.js";
import { runExclusive } from "./job-lock.js";
import slaService from "../modules/task/services/sla.service.js";

const SLA_CRON_EXPRESSION = "*/5 * * * *";

export const scheduleSlaJob = (): cron.ScheduledTask => {
  logger.info("Scheduling SLA breach job", { expression: SLA_CRON_EXPRESSION });

  return cron.schedule(SLA_CRON_EXPRESSION, async () => {
    await runExclusive("sla-breaches", 240000, async () => {
      try {
        const updated = await slaService.updateBreaches();
        if (updated > 0) {
          logger.info("SLA breach job updated tasks", { updated });
        }
      } catch (error) {
        logger.error("SLA breach job failed", {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });
  });
};
