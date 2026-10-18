import cron from "node-cron";

import logger from "../lib/logger.js";
import { runExclusive } from "./job-lock.js";
import priorityEngineService from "../modules/task/services/priority-engine.service.js";

const PRIORITY_ENGINE_CRON_EXPRESSION = "*/10 * * * *";

export const schedulePriorityEngineJob = (): cron.ScheduledTask => {
  logger.info("Scheduling dynamic priority job", {
    expression: PRIORITY_ENGINE_CRON_EXPRESSION,
  });

  return cron.schedule(PRIORITY_ENGINE_CRON_EXPRESSION, async () => {
    await runExclusive("priority-engine", 540000, async () => {
      try {
        const updated = await priorityEngineService.recalculateAllOpenTasks();
        logger.info("Dynamic priority job evaluated tasks", { updated });
      } catch (error) {
        logger.error("Dynamic priority job failed", {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });
  });
};
