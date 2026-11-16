import { Schema, model, type Document } from "mongoose";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Logs are kept for 30 days. */
export const LOG_RETENTION_DAYS = 30;

export interface ILogEntry {
  integrationId: string;
  /** Sent by the SDK so a retry after a lost response does not store the log twice. */
  logId: string | null;
  ts: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
  traceId: string | null;
  userIdentifier: string | null;
  createdAt: Date;
}
export interface ILogEntryDocument extends ILogEntry, Document {}

const logSchema = new Schema<ILogEntryDocument>(
  {
    integrationId: { type: String, required: true },
    logId: { type: String, default: null },
    ts: { type: Date, required: true },
    level: { type: String, enum: LOG_LEVELS, required: true },
    service: { type: String, default: "app", maxlength: 80 },
    message: { type: String, default: "", maxlength: 8000 },
    attributes: { type: Schema.Types.Mixed, default: {} },
    traceId: { type: String, default: null },
    userIdentifier: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  },
);
logSchema.index({ integrationId: 1, ts: -1 });
logSchema.index({ integrationId: 1, level: 1, ts: -1 });
logSchema.index({ integrationId: 1, service: 1, ts: -1 });
logSchema.index({ integrationId: 1, traceId: 1 }, { sparse: true });
logSchema.index({ integrationId: 1, logId: 1 }, { sparse: true });
logSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: LOG_RETENTION_DAYS * 86400 },
);

export const LogEntryModel = model<ILogEntryDocument>("LogEntry", logSchema);
