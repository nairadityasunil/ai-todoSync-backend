import cron from "node-cron";

import logger from "../../lib/logger.js";
import { runExclusive } from "../../utils/job-lock.js";
import approvalService from "./approval.service.js";
import { detectAlerts, recomputeAllRisk } from "./governance.service.js";

const ALERTS_CRON = "*/5 * * * *";
const RISK_CRON = "17 3 * * *";

const run =
  (name: string, ttlMs: number, job: () => Promise<unknown>) => async () => {
    await runExclusive(name, ttlMs, async () => {
      try {
        const result = await job();
        logger.info(`Agent governance job ${name} finished`, { result });
      } catch (error) {
        logger.error(`Agent governance job ${name} failed`, {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  };

export const scheduleAgentGovernanceJobs = (): cron.ScheduledTask[] => [
  cron.schedule(
    ALERTS_CRON,
    run("agent-alerts", 240000, async () => ({
      alerts: await detectAlerts(),
      expiredApprovals: await approvalService.expireStale(),
    })),
  ),
  cron.schedule(RISK_CRON, run("agent-risk", 3_000_000, recomputeAllRisk)),
];
