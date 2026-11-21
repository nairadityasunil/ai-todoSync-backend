import dns from "node:dns";
import mongoose from "mongoose";

if (process.env.NODE_ENV !== "production") {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
}

import env from "./env.js";
import logger from "../lib/logger.js";

let isConnected = false;
const DATABASE_TIMEOUT_MS = 10000;

mongoose.set("bufferCommands", false);

const updateConnectionState = (): void => {
  isConnected = mongoose.connection.readyState === 1;
};

mongoose.connection.on("connected", () => {
  updateConnectionState();
  logger.info("MongoDB connection established");
});

mongoose.connection.on("disconnected", () => {
  updateConnectionState();
  logger.warn("MongoDB connection disconnected");
});

mongoose.connection.on("error", (error) => {
  updateConnectionState();
  if (isConnected) {
    logger.error("MongoDB connection error", error as Error);
  }
});

export const connectDatabase = async (): Promise<void> => {
  if (isConnected) {
    return;
  }

  try {
    await mongoose.connect(env.MONGODB_URI, {
      dbName: "pristine",
      serverSelectionTimeoutMS: DATABASE_TIMEOUT_MS,
      connectTimeoutMS: DATABASE_TIMEOUT_MS,
      bufferCommands: false,
    });

    updateConnectionState();
    logger.info("Connected to MongoDB");
  } catch (error) {
    updateConnectionState();
    logger.error("Failed to connect to MongoDB during startup", {
      timeoutMs: DATABASE_TIMEOUT_MS,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });
    throw error;
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  if (!isConnected) {
    return;
  }

  await mongoose.disconnect();
  isConnected = false;
};

export const isDatabaseConnected = (): boolean =>
  mongoose.connection.readyState === 1;
