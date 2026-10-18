import cron from "node-cron";

import logger from "../lib/logger.js";
import { runExclusive } from "./job-lock.js";
import semanticOperationalIntelligenceService from "../modules/analytics/services/semantic-operational-intelligence.service.js";

const SEMANTIC_ROLLUP_CRON_EXPRESSION = "17 * * * *";

export const scheduleSemanticRollupJob = (): cron.ScheduledTask => {
  logger.info("Scheduling semantic rollup job", {
    expression: SEMANTIC_ROLLUP_CRON_EXPRESSION,
  });

  return cron.schedule(SEMANTIC_ROLLUP_CRON_EXPRESSION, async () => {
    await runExclusive("semantic-rollup", 3000000, async () => {
      try {
        const result =
          await semanticOperationalIntelligenceService.writeScheduledRollupSnapshots();
        logger.info("Semantic rollup job completed", result);
      } catch (error) {
        logger.error("Semantic rollup job failed", {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });
  });
};
