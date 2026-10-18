import { Response } from "express";
import crypto from "crypto";
import { AuthenticatedRequest } from "../../../types/auth.js";
import {
  listCompanionDevicesByUser,
  countActiveCompanionDevices,
  revokeCompanionDevice,
  updateCompanionDevice,
} from "../../../modules/ai/repositories/companion-device.repository.js";
import {
  createCompanionKey,
  listUnusedCompanionKeysByUser,
  deleteCompanionKeyById,
} from "../../../modules/ai/repositories/companion-key.repository.js";
import {
  createQRPairingSession,
  findQRPairingSessionBySessionId,
  consumeQRPairingSession,
} from "../../../modules/ai/repositories/qr-pairing-session.repository.js";
import { deterministicHash } from "../../../utils/encryption.js";
import { AppError } from "../../../utils/app-error.js";
import authService from "../../../modules/auth/services/auth.service.js";
import chatSocketServer from "../../../socket/chat.socket.js";

const VALID_DEVICE_TYPES = [
  "mobile",
  "tablet",
  "desktop",
  "assistant",
  "companion",
];

function extractWorkspaceId(req: AuthenticatedRequest): string | null {
  const wsId =
    req.workspaceAccess?.workspace?._id?.toString() ||
    (typeof req.headers["x-workspace-id"] === "string"
      ? req.headers["x-workspace-id"]
      : null) ||
    (typeof req.query.workspaceId === "string" ? req.query.workspaceId : null);
  return wsId && wsId.trim() ? wsId.trim() : null;
}

export interface CompanionHardwareInfo {
  name?: string;
  type?: string;
  platform?: string;
  model?: string;
  appVersion?: string;
}

export function formatDeterministicDeviceName(
  deviceInfo?: CompanionHardwareInfo,
  userAgent?: string,
): { deviceName: string; deviceType: string } {
  const rawType = deviceInfo?.type?.toLowerCase() || "mobile";
  const type = VALID_DEVICE_TYPES.includes(rawType) ? rawType : "mobile";

  // 1. Explicit device name if provided and meaningful
  if (
    deviceInfo?.name &&
    deviceInfo.name.trim() &&
    !/^device-[0-9a-f-]+$/i.test(deviceInfo.name.trim())
  ) {
    return { deviceName: deviceInfo.name.trim(), deviceType: type };
  }

  // 2. Platform + model
  if (deviceInfo?.platform && deviceInfo?.model) {
    return {
      deviceName: `${deviceInfo.platform} (${deviceInfo.model})`,
      deviceType: type,
    };
  }
  if (deviceInfo?.model) {
    return { deviceName: deviceInfo.model, deviceType: type };
  }

  // 3. User agent parsing
  if (userAgent) {
    let os = "";
    if (/iphone/i.test(userAgent)) os = "iPhone";
    else if (/ipad/i.test(userAgent)) os = "iPad";
    else if (/android/i.test(userAgent)) os = "Android Phone";
    else if (/macintosh|mac os x/i.test(userAgent)) os = "MacBook Pro";
    else if (/windows/i.test(userAgent)) os = "Windows PC";
    else if (/linux/i.test(userAgent)) os = "Linux Workstation";

    let browser = "";
    if (/chrome|crios/i.test(userAgent) && !/edg/i.test(userAgent))
      browser = "Chrome";
    else if (/firefox|fxios/i.test(userAgent)) browser = "Firefox";
    else if (/safari/i.test(userAgent) && !/chrome/i.test(userAgent))
      browser = "Safari";
    else if (/edg/i.test(userAgent)) browser = "Edge";

    if (browser && os) {
      return { deviceName: `${browser} on ${os}`, deviceType: type };
    } else if (os) {
      return { deviceName: os, deviceType: type };
    }
  }

  // 4. Fallback generic device name
  const capitalizedType = type.charAt(0).toUpperCase() + type.slice(1);
  return { deviceName: `${capitalizedType} Device`, deviceType: type };
}

/**
 * FLOW A — Generate Pairing Key
 * Requires Device Name + Device Type form.
 * Generates 32-byte secret, stores hash, returns key ONCE.
 */
export const createCompanionDevice = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const userId = req.user._id.toString();
  const workspaceId = extractWorkspaceId(req);

  const { deviceName, deviceType } = req.body as {
    deviceName?: string;
    deviceType?: string;
  };

  const trimmedName = deviceName?.trim();
  if (!trimmedName || trimmedName.length > 50) {
    throw new AppError(
      400,
      "Valid device name is required (1-50 characters)",
      "BAD_REQUEST",
    );
  }

  const trimmedType = deviceType?.trim().toLowerCase();
  if (!trimmedType || !VALID_DEVICE_TYPES.includes(trimmedType)) {
    throw new AppError(
      400,
      `Invalid device type. Allowed: ${VALID_DEVICE_TYPES.join(", ")}`,
      "BAD_REQUEST",
    );
  }

  const activeCount = await countActiveCompanionDevices(userId, workspaceId);
  if (activeCount >= 5) {
    throw new AppError(
      409,
      "Maximum active companion devices (5) reached",
      "CONFLICT",
    );
  }

  const rawKey = `cmp_${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = deterministicHash(rawKey);

  const companionKeyDoc = await createCompanionKey({
    userId,
    workspaceId,
    keyHash,
    deviceName: trimmedName,
    deviceType: trimmedType,
  });

  res.status(201).json({
    message:
      "Companion key generated successfully. Save your pairing key now; it will not be displayed again.",
    device: {
      id: companionKeyDoc._id.toString(),
      deviceName: trimmedName,
      deviceType: trimmedType,
      status: "pending",
      createdAt: companionKeyDoc.createdAt?.toISOString(),
    },
    pairingKey: rawKey,
  });
};

/**
 * FLOW B — Create QR Pairing Session
 * Initiated by Primary Device. DOES NOT generate a pairing key or require manual key entry.
 */
export const createQrPairingSession = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const userId = req.user._id.toString();
  const workspaceId = extractWorkspaceId(req);

  const sessionId = `qrs_${crypto.randomBytes(16).toString("hex")}`;
  const qrToken = `qrt_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes validity

  await createQRPairingSession({
    sessionId,
    userId,
    workspaceId,
    qrToken,
    expiresAt,
  });

  const originHeader =
    typeof req.headers.origin === "string" ? req.headers.origin : null;
  const hostHeader =
    typeof req.headers.host === "string" ? `http://${req.headers.host}` : null;
  const baseUrl = (
    originHeader ||
    hostHeader ||
    "http://localhost:5173"
  ).replace(/\/$/, "");

  const payload = `${baseUrl}/login?mode=companion&sessionId=${sessionId}&token=${qrToken}`;

  res.status(201).json({
    message: "QR pairing session created successfully",
    data: {
      sessionId,
      qrToken,
      expiresAt: expiresAt.toISOString(),
      payload,
    },
  });
};

/**
 * FLOW B — Check QR Session Status
 * Polling fallback for Primary Device listening to QR pairing completion.
 */
export const getQrSessionStatus = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const paramVal = req.params.sessionId;
  const sessionId = Array.isArray(paramVal) ? paramVal[0] : paramVal;
  const session = await findQRPairingSessionBySessionId(sessionId);

  if (!session) {
    throw new AppError(404, "QR pairing session not found", "NOT_FOUND");
  }

  if (session.userId.toString() !== req.user._id.toString()) {
    throw new AppError(403, "Forbidden access to pairing session", "FORBIDDEN");
  }

  res.status(200).json({
    status: session.status,
    isUsed: session.isUsed,
    expiresAt: session.expiresAt.toISOString(),
  });
};

/**
 * FLOW B — Companion Device Scans QR Code
 * Validates QR session, extracts device hardware info, creates companion device immediately, and logs companion in.
 * NO key is generated or entered.
 */
export const pairCompanionDeviceWithQr = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  const { sessionId, token, qrToken, device } = req.body as {
    sessionId?: string;
    token?: string;
    qrToken?: string;
    device?: CompanionHardwareInfo;
  };

  const actualToken = token || qrToken;
  const trimmedSessionId = sessionId?.trim();
  const trimmedToken = actualToken?.trim();

  if (!trimmedSessionId || !trimmedToken) {
    throw new AppError(
      400,
      "Session ID and QR token are required",
      "BAD_REQUEST",
    );
  }

  const now = new Date();
  const session = await consumeQRPairingSession(
    trimmedSessionId,
    trimmedToken,
    now,
  );

  if (!session) {
    throw new AppError(
      401,
      "QR pairing session is invalid, expired, or already used",
      "UNAUTHORIZED",
    );
  }

  const userId = session.userId.toString();
  const userAgent = req.get("user-agent") ?? undefined;

  const { deviceName, deviceType } = formatDeterministicDeviceName(
    device,
    userAgent,
  );

  const authResult = await authService.loginCompanionDeviceWithQr({
    userId,
    workspaceId: session.workspaceId ? session.workspaceId.toString() : null,
    deviceName,
    deviceType,
    userAgent: userAgent ?? null,
  });

  // Notify primary device via Socket.IO room user:${userId}
  try {
    chatSocketServer.notifyUser(userId, "companion:paired", {
      sessionId: session.sessionId,
      deviceName,
      deviceType,
      pairedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("Failed to emit socket event companion:paired", err);
  }

  res.status(200).json({
    message: "Companion device linked successfully via QR Code",
    data: {
      user: authResult.user,
      token: authResult.token,
      refreshToken: authResult.refreshToken,
      session: authResult.session,
    },
  });
};

/**
 * FLOW A — Companion Device Enters Pairing Key
 */
export const pairCompanionDeviceWithKey = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  const { pairingKey } = req.body as { pairingKey?: string };
  const trimmedKey = pairingKey?.trim();

  if (!trimmedKey) {
    throw new AppError(400, "Pairing key is required", "BAD_REQUEST");
  }

  const authResult = await authService.loginCompanionDevice({
    key: trimmedKey,
    userAgent: req.get("user-agent") ?? null,
  });

  res.status(200).json({
    message: "Companion device paired successfully",
    data: {
      user: authResult.user,
      token: authResult.token,
      refreshToken: authResult.refreshToken,
      session: authResult.session,
    },
  });
};

/**
 * List Companion Devices
 */
export const getCompanionDevices = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const userId = req.user._id.toString();
  const workspaceId = extractWorkspaceId(req);

  const [activeDevices, pendingKeys] = await Promise.all([
    listCompanionDevicesByUser(userId, workspaceId),
    listUnusedCompanionKeysByUser(userId, workspaceId),
  ]);

  const activeList = activeDevices.map((d) => ({
    id: d._id.toString(),
    deviceName: d.deviceName,
    deviceType: d.deviceType,
    status: d.status,
    createdAt: d.createdAt?.toISOString(),
    updatedAt: d.updatedAt?.toISOString(),
    revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
  }));

  const pendingList = pendingKeys.map((k) => ({
    id: k._id.toString(),
    deviceName: k.deviceName || "Pending Device",
    deviceType: k.deviceType || "mobile",
    status: "pending",
    createdAt: k.createdAt?.toISOString(),
    updatedAt: k.updatedAt?.toISOString(),
    revokedAt: null,
  }));

  res.status(200).json({
    message: "Companion devices fetched successfully",
    data: { devices: [...pendingList, ...activeList] },
  });
};

/**
 * Regenerate Companion Key (Flow A)
 */
export const regenerateCompanionKey = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const userId = req.user._id.toString();
  const deviceId = req.params.deviceId as string;
  const workspaceId = extractWorkspaceId(req);

  const existingPendingKey = await deleteCompanionKeyById(userId, deviceId);
  const rawKey = `cmp_${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = deterministicHash(rawKey);

  const newKeyDoc = await createCompanionKey({
    userId,
    workspaceId,
    keyHash,
    deviceName: existingPendingKey?.deviceName || "Companion Device",
    deviceType: existingPendingKey?.deviceType || "mobile",
  });

  res.status(200).json({
    message:
      "Companion key regenerated. Save your key now; it will not be displayed again.",
    device: {
      id: newKeyDoc._id.toString(),
      deviceName: newKeyDoc.deviceName,
      deviceType: newKeyDoc.deviceType,
      status: "pending",
    },
    pairingKey: rawKey,
  });
};

export const updateCompanionDeviceHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const userId = req.user._id.toString();
  const deviceId = req.params.deviceId as string;
  const workspaceId = extractWorkspaceId(req);
  const { deviceName, deviceType } = req.body as {
    deviceName?: string;
    deviceType?: string;
  };

  const updated = await updateCompanionDevice(
    userId,
    deviceId,
    {
      ...(deviceName && { deviceName: deviceName.trim() }),
      ...(deviceType && { deviceType: deviceType.trim() }),
    },
    workspaceId,
  );

  if (!updated) {
    throw new AppError(404, "Companion device not found", "NOT_FOUND");
  }

  res.status(200).json({
    message: "Companion device updated successfully",
    data: {
      device: {
        id: updated._id.toString(),
        deviceName: updated.deviceName,
        deviceType: updated.deviceType,
        status: updated.status,
      },
    },
  });
};

export const revokeCompanionDeviceHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  if (!req.user?._id) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const userId = req.user._id.toString();
  const deviceId = req.params.deviceId as string;
  const workspaceId = extractWorkspaceId(req);

  const revoked = await revokeCompanionDevice(
    userId,
    deviceId,
    new Date(),
    workspaceId,
  );

  if (!revoked) {
    const deletedKey = await deleteCompanionKeyById(userId, deviceId);
    if (!deletedKey) {
      throw new AppError(404, "Companion device or key not found", "NOT_FOUND");
    }
  }

  res.status(200).json({
    message: "Companion device revoked successfully",
  });
};
