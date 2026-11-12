import { detectCostDrift, monitorCompliance, runScheduledReports } from "./compliance.service.js";
import cron from "node-cron";

import logger from "../../lib/logger.js";
import { runExclusive } from "../../utils/job-lock.js";
import approvalService from "./approval.service.js";
import { expireElevations, recomputeAllBaselines, runKeyLifecycle } from "./advanced.service.js";
import vendorService from "../vendors/service.js";
import {
  detectAlerts,
  enforceAgentHygiene,
  recomputeAllRisk,
} from "./governance.service.js";

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
      // Just-in-time grants end on time even if no call checks them.
      expiredElevations: await expireElevations(),
    })),
  ),
  // Hygiene first, so suspended agents are scored as such.
  cron.schedule(
    RISK_CRON,
    run("agent-risk", 3_000_000, async () => ({
      hygiene: await enforceAgentHygiene(),
      baselines: await recomputeAllBaselines(),
      keys: await runKeyLifecycle(),
      scored: await recomputeAllRisk(),
      vendors: await vendorService.nightly(),
      // After scoring, so the compliance snapshot sees fresh risk levels.
      costDrift: await detectCostDrift(),
      compliance: await monitorCompliance(),
      reports: await runScheduledReports(),
    })),
  ),
];
