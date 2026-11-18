import mongoose from "mongoose";

import logger from "../lib/logger.js";

export interface IndexReport {
  models: number;
  failed: Array<{ model: string; error: string }>;
  created: Array<{ model: string; indexes: string[] }>;
  ms: number;
}

/**
 * Builds every index the models declare.
 *
 * Mongoose builds indexes itself when a model loads, but this app connects with `bufferCommands: false`, so
 * that build can run before the connection is ready and be skipped without any error. Indexes declared in a
 * schema (a TTL on sessions, the lookup of invitations by email, time entries, ...) could then be missing from
 * the database. Calling this after the connection is open fixes that and is safe to repeat: existing indexes are
 * left alone, nothing is dropped.
 */
export async function ensureIndexes(): Promise<IndexReport> {
  const started = Date.now();
  const report: IndexReport = { models: 0, failed: [], created: [], ms: 0 };
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    report.models += 1;
    try {
      const before = await model
        .listIndexes()
        .catch(() => [] as Array<{ name?: string }>);
      await model.createIndexes();
      const after = await model
        .listIndexes()
        .catch(() => [] as Array<{ name?: string }>);
      const had = new Set(before.map((i) => i.name));
      const added = after
        .map((i) => i.name ?? "")
        .filter((n) => n && !had.has(n));
      added.splice(0, added.length, ...added.filter((n) => n !== "_id_"));
      if (added.length) report.created.push({ model: name, indexes: added });
    } catch (error) {
      // One bad index (for example a unique index over existing duplicates) must not stop the others.
      report.failed.push({
        model: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  report.ms = Date.now() - started;
  return report;
}

/** Runs ensureIndexes in the background after startup and logs what it did. */
export function ensureIndexesInBackground(): void {
  if (process.env.DB_ENSURE_INDEXES === "false") return;
  void ensureIndexes()
    .then((report) => {
      const added = report.created.reduce((n, c) => n + c.indexes.length, 0);
      logger.info(
        `Indexes checked for ${report.models} models in ${report.ms} ms; ${added} created`,
      );
      for (const c of report.created)
        logger.info(`Created indexes on ${c.model}: ${c.indexes.join(", ")}`);
      for (const f of report.failed)
        logger.warn(`Could not build indexes on ${f.model}: ${f.error}`);
    })
    .catch((error) => {
      logger.warn(
        `Index check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}
