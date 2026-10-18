import os from "os";
import { randomUUID } from "crypto";
import { Schema, model } from "mongoose";

import logger from "../lib/logger.js";

interface IJobLock {
  _id: string;
  owner: string;
  lockedUntil: Date;
}

const jobLockSchema = new Schema<IJobLock>(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
  },
  { versionKey: false, collection: "job_locks" },
);

export const JobLockModel = model<IJobLock>("JobLock", jobLockSchema);

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number })?.code === 11000;

/**
 * Runs `task` only if no other process (or earlier run in this process)
 * holds the named lock. Scheduled jobs use this so that, with several API
 * instances, each job runs once per tick and runs never overlap. The lock
 * expires after `ttlMs` so a crashed holder cannot block the job forever.
 */
export const runExclusive = async (
  name: string,
  ttlMs: number,
  task: () => Promise<void>,
): Promise<boolean> => {
  const now = new Date();
  try {
    await JobLockModel.findOneAndUpdate(
      { _id: name, lockedUntil: { $lte: now } },
      {
        $set: {
          owner: INSTANCE_ID,
          lockedUntil: new Date(now.getTime() + ttlMs),
        },
      },
      { upsert: true },
    ).exec();
  } catch (error) {
    if (isDuplicateKey(error)) {
      logger.debug("Skipping job, another run holds the lock", { job: name });
    } else {
      logger.error("Failed to acquire job lock", {
        job: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }

  try {
    await task();
  } finally {
    await JobLockModel.updateOne(
      { _id: name, owner: INSTANCE_ID },
      { $set: { lockedUntil: new Date() } },
    )
      .exec()
      .catch((error: unknown) => {
        logger.error("Failed to release job lock", {
          job: name,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return true;
};
