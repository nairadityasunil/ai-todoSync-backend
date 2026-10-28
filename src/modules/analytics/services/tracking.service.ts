import crypto from "crypto";
import AnalyticsEventRegistryModel from "../models/analytics-event-registry.model.js";
import AnalyticsLogModel, {
  IAnalyticsLogDocument,
} from "../../../modules/analytics/models/analytics-log.model.js";
import AnalyticsUserModel from "../models/analytics-user.model.js";
import { classifyTraffic } from "../traffic.js";
import logger from "../../../lib/logger.js";
import {
  NormalizedTrackingEvent,
  normalizeTrackingEvent,
  validateBatchBody,
  validatePayloadSize,
} from "../validators/tracking.validator.js";

type JsonRecord = Record<string, unknown>;

/**
 * Classifies the client behind an event. The browser's own report (sent by
 * the SDK in context) wins over the request header, so server-side tracking
 * calls made for a visitor keep the visitor's browser.
 */
const trafficOf = (
  payload: Record<string, unknown>,
  client?: TrackingClient,
) => {
  const context = (payload.context ?? {}) as {
    userAgent?: unknown;
    automation?: { webdriver?: unknown };
  };
  return classifyTraffic({
    userAgent:
      typeof context.userAgent === "string"
        ? context.userAgent
        : (client?.userAgent ?? null),
    webdriver: context.automation?.webdriver === true,
  });
};

/** What the HTTP request says about the client (for traffic classification). */
export interface TrackingClient {
  userAgent?: string | null;
}

interface SingleTrackInput {
  client?: TrackingClient;
  apiKeyId: string;
  sdkIntegrationId?: string;
  eventName: string;
  payload?: JsonRecord;
  userIdentifier?: string;
  sessionId?: string;
  eventId?: string;
}

interface BatchResult {
  insertedCount: number;
  ignoredCount: number;
  attemptedCount: number;
}

interface StaticConfig {
  sampleRate: number;
  batchSize: number;
  featureFlags: {
    batching: boolean;
    retries: boolean;
    offlineQueue: boolean;
    autoPageTracking: boolean;
  };
}

const DEFAULT_CONFIG: StaticConfig = {
  sampleRate: 1,
  batchSize: 20,
  featureFlags: {
    batching: true,
    retries: true,
    offlineQueue: true,
    autoPageTracking: true,
  },
};

type BulkWriteErrorLike = {
  code?: number;
  writeErrors?: Array<{ code?: number }>;
  result?: { result?: { writeErrors?: Array<{ code?: number }> } };
};

class TrackingService {
  private generateEventId(): string {
    return crypto.randomUUID();
  }

  private async ensureEventRegistry(
    eventName: string,
    apiKeyId: string,
    sdkIntegrationId?: string,
  ) {
    // Prefer sdkIntegrationId-based lookup when available
    const lookupFilter = sdkIntegrationId
      ? { eventName, sdkIntegrationId }
      : { eventName, apiKeyId };

    const existing = await AnalyticsEventRegistryModel.findOne(lookupFilter)
      .lean()
      .exec();

    if (existing) {
      return existing;
    }

    try {
      return await AnalyticsEventRegistryModel.create({
        eventName,
        apiKeyId,
        ...(sdkIntegrationId
          ? { sdkIntegrationId }
          : { sdkIntegrationId: apiKeyId }),
      });
    } catch (error) {
      const duplicate = this.isDuplicateKeyError(error);
      if (!duplicate) {
        throw error;
      }

      const created = await AnalyticsEventRegistryModel.findOne(lookupFilter)
        .lean()
        .exec();

      if (!created) {
        throw error;
      }

      return created;
    }
  }

  private buildLogDocument(
    event: NormalizedTrackingEvent,
    apiKeyId: string,
    eventRef: string,
    sdkIntegrationId?: string,
    client?: TrackingClient,
  ) {
    return {
      eventId: event.eventId || this.generateEventId(),
      eventRef,
      apiKeyId,
      sdkIntegrationId: sdkIntegrationId ?? apiKeyId,
      userIdentifier: event.userIdentifier,
      sessionId: event.sessionId,
      payload: { ...event.payload, traffic: trafficOf(event.payload, client) },
    };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    const candidate = error as BulkWriteErrorLike | undefined;
    if (candidate?.code === 11000) {
      return true;
    }

    return (
      candidate?.writeErrors?.some((writeError) => writeError.code === 11000) ??
      candidate?.result?.result?.writeErrors?.some(
        (writeError) => writeError.code === 11000,
      ) ??
      false
    );
  }

  public async trackSingle(
    input: SingleTrackInput,
  ): Promise<IAnalyticsLogDocument | null> {
    const normalized = normalizeTrackingEvent(
      {
        eventName: input.eventName,
        eventId: input.eventId,
        userIdentifier: input.userIdentifier,
        sessionId: input.sessionId,
        payload: input.payload,
      },
      { requireEventId: false },
    );
    normalized.eventId = normalized.eventId || this.generateEventId();

    if (normalized.userIdentifier) {
      await this.ensureIdentityExists(
        input.apiKeyId,
        normalized.userIdentifier,
      );
    }

    const event = await this.ensureEventRegistry(
      normalized.eventName,
      input.apiKeyId,
      input.sdkIntegrationId,
    );

    try {
      return await AnalyticsLogModel.create(
        this.buildLogDocument(
          normalized,
          input.apiKeyId,
          event._id.toString(),
          input.sdkIntegrationId,
          input.client,
        ),
      );
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return null;
      }

      throw error;
    }
  }

  public async ingestBatch(
    apiKeyId: string,
    body: unknown,
    sdkIntegrationId?: string,
    client?: TrackingClient,
  ): Promise<BatchResult> {
    const rawEvents = validateBatchBody(body);
    const normalizedEvents = rawEvents.map((event, index) =>
      normalizeTrackingEvent(event, {
        requireEventId: rawEvents.length > 1 || index > 0,
      }),
    );

    const eventNames = [
      ...new Set(normalizedEvents.map((event) => event.eventName)),
    ];
    const eventDocs = await Promise.all(
      eventNames.map(async (eventName) => {
        const event = await this.ensureEventRegistry(
          eventName,
          apiKeyId,
          sdkIntegrationId,
        );
        return [eventName, event._id.toString()] as const;
      }),
    );
    const eventRefByName = new Map(eventDocs);

    const userIdentifiers = [
      ...new Set(
        normalizedEvents
          .map((event) => event.userIdentifier)
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    if (userIdentifiers.length > 0) {
      await Promise.all(
        userIdentifiers.map((identifier) =>
          this.upsertIdentity(apiKeyId, identifier, {}),
        ),
      );
    }

    const operations = normalizedEvents.map((event) => ({
      insertOne: {
        document: this.buildLogDocument(
          {
            ...event,
            eventId: event.eventId || this.generateEventId(),
          },
          apiKeyId,
          eventRefByName.get(event.eventName) as string,
          sdkIntegrationId,
          client,
        ),
      },
    }));

    try {
      const result = await AnalyticsLogModel.bulkWrite(operations, {
        ordered: false,
      });

      return {
        insertedCount: result.insertedCount,
        ignoredCount: normalizedEvents.length - result.insertedCount,
        attemptedCount: normalizedEvents.length,
      };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      logger.warn("Duplicate analytics events ignored during batch ingest", {
        apiKeyId,
        attemptedCount: normalizedEvents.length,
      });

      const duplicateCount = this.countDuplicateWriteErrors(error);

      return {
        insertedCount: normalizedEvents.length - duplicateCount,
        ignoredCount: duplicateCount,
        attemptedCount: normalizedEvents.length,
      };
    }
  }

  public async identify(
    apiKeyId: string,
    userIdentifier: string,
    traits: JsonRecord,
  ) {
    validatePayloadSize(traits);
    return this.upsertIdentity(apiKeyId, userIdentifier, traits);
  }

  public async alias(
    apiKeyId: string,
    previousId: string,
    userIdentifier: string,
  ): Promise<{ matchedLogs: number; modifiedLogs: number }> {
    if (previousId === userIdentifier) {
      return { matchedLogs: 0, modifiedLogs: 0 };
    }

    const [previousUser, currentUser] = await Promise.all([
      AnalyticsUserModel.findOne({ apiKeyId, userIdentifier: previousId })
        .lean()
        .exec(),
      AnalyticsUserModel.findOne({ apiKeyId, userIdentifier }).lean().exec(),
    ]);

    const mergedMetadata = {
      ...(previousUser?.metadata ?? {}),
      ...(currentUser?.metadata ?? {}),
    };

    await this.upsertIdentity(apiKeyId, userIdentifier, mergedMetadata);

    const updateResult = await AnalyticsLogModel.updateMany(
      { apiKeyId, userIdentifier: previousId },
      { $set: { userIdentifier } },
    ).exec();

    if (previousUser) {
      await AnalyticsUserModel.deleteOne({
        apiKeyId,
        userIdentifier: previousId,
      }).exec();
    }

    return {
      matchedLogs: updateResult.matchedCount,
      modifiedLogs: updateResult.modifiedCount,
    };
  }

  public async page(
    apiKeyId: string,
    input: {
      url: string;
      title?: string;
      referrer?: string;
      userIdentifier?: string;
      sessionId?: string;
      eventId?: string;
    },
    client?: TrackingClient,
  ): Promise<IAnalyticsLogDocument | null> {
    return this.trackSingle({
      apiKeyId,
      client,
      eventName: "page",
      userIdentifier: input.userIdentifier,
      sessionId: input.sessionId,
      eventId: input.eventId,
      payload: {
        url: input.url,
        title: input.title,
        referrer: input.referrer,
        properties: {
          url: input.url,
          title: input.title,
          referrer: input.referrer,
        },
        type: "page",
      },
    });
  }

  public getConfig(): StaticConfig {
    return DEFAULT_CONFIG;
  }

  private async upsertIdentity(
    apiKeyId: string,
    userIdentifier: string,
    metadata: JsonRecord,
  ) {
    return AnalyticsUserModel.findOneAndUpdate(
      { apiKeyId, userIdentifier },
      {
        $set: { metadata },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true },
    ).exec();
  }

  private async ensureIdentityExists(apiKeyId: string, userIdentifier: string) {
    return AnalyticsUserModel.findOneAndUpdate(
      { apiKeyId, userIdentifier },
      { $setOnInsert: { createdAt: new Date(), metadata: {} } },
      { upsert: true, new: true },
    ).exec();
  }

  private countDuplicateWriteErrors(error: unknown): number {
    const candidate = error as BulkWriteErrorLike | undefined;
    const direct = candidate?.writeErrors?.filter(
      (writeError) => writeError.code === 11000,
    ).length;

    if (typeof direct === "number" && direct > 0) {
      return direct;
    }

    return (
      candidate?.result?.result?.writeErrors?.filter(
        (writeError) => writeError.code === 11000,
      ).length ?? 0
    );
  }
}

const trackingService = new TrackingService();

export default trackingService;
