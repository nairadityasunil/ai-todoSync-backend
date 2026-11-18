/**
 * Builds every index the models declare, then lists what was created or could not be built.
 * Run after a deploy, or by hand on a database that has missing indexes: `npm run db:indexes`.
 * Safe to repeat. It never drops an index.
 */
import mongoose from "mongoose";

import { connectDatabase, disconnectDatabase } from "../config/db.config.js";
import { ensureIndexes } from "../config/indexes.js";

// Loading the app registers every model (routes import them), so all of them are covered.
await import("../app.js");
await connectDatabase();
const report = await ensureIndexes();
const lines = [
  `Checked ${report.models} models in ${report.ms} ms (${mongoose.connection.name})`,
  ...report.created.map(
    (c) => `  created on ${c.model}: ${c.indexes.join(", ")}`,
  ),
  ...report.failed.map((f) => `  FAILED on ${f.model}: ${f.error}`),
  report.created.length === 0 && report.failed.length === 0
    ? "  every declared index already exists"
    : "",
].filter(Boolean);
process.stdout.write(lines.join("\n") + "\n");
await disconnectDatabase();
process.exit(report.failed.length ? 1 : 0);
