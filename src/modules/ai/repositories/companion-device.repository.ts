import CompanionDeviceModel, {
  ICompanionDevice,
  ICompanionDeviceDocument,
} from "../../../modules/ai/models/companion-device.model.js";

export const createCompanionDevice = async (
  payload: ICompanionDevice,
): Promise<ICompanionDeviceDocument> => CompanionDeviceModel.create(payload);

export const countActiveCompanionDevices = async (
  userId: string,
  workspaceId?: string | null,
): Promise<number> => {
  const query: Record<string, unknown> = { userId, status: "active" };
  if (workspaceId) {
    query.$or = [
      { workspaceId },
      { workspaceId: null },
      { workspaceId: { $exists: false } },
    ];
  }
  return CompanionDeviceModel.countDocuments(query).exec();
};

export const findCompanionDeviceById = async (
  deviceId: string,
): Promise<ICompanionDeviceDocument | null> =>
  CompanionDeviceModel.findById(deviceId).exec();

export const findCompanionDeviceByIdForUser = async (
  userId: string,
  deviceId: string,
  workspaceId?: string | null,
): Promise<ICompanionDeviceDocument | null> => {
  const query: Record<string, unknown> = { _id: deviceId, userId };
  if (workspaceId) {
    query.$or = [
      { workspaceId },
      { workspaceId: null },
      { workspaceId: { $exists: false } },
    ];
  }
  return CompanionDeviceModel.findOne(query).exec();
};

export const listCompanionDevicesByUser = async (
  userId: string,
  workspaceId?: string | null,
): Promise<ICompanionDeviceDocument[]> => {
  const query: Record<string, unknown> = {
    userId,
    status: { $in: ["active", "pending"] },
  };
  if (workspaceId) {
    query.$or = [
      { workspaceId },
      { workspaceId: null },
      { workspaceId: { $exists: false } },
    ];
  }
  return CompanionDeviceModel.find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .exec();
};

export const revokeCompanionDevice = async (
  userId: string,
  deviceId: string,
  revokedAt: Date,
  workspaceId?: string | null,
): Promise<ICompanionDeviceDocument | null> => {
  const query: Record<string, unknown> = {
    _id: deviceId,
    userId,
    status: { $ne: "revoked" },
  };
  if (workspaceId) {
    query.$or = [
      { workspaceId },
      { workspaceId: null },
      { workspaceId: { $exists: false } },
    ];
  }
  return CompanionDeviceModel.findOneAndUpdate(
    query,
    { status: "revoked", revokedAt },
    { new: true },
  ).exec();
};

export const updateCompanionDevice = async (
  userId: string,
  deviceId: string,
  updates: Partial<Pick<ICompanionDevice, "deviceName" | "deviceType">>,
  workspaceId?: string | null,
): Promise<ICompanionDeviceDocument | null> => {
  const query: Record<string, unknown> = { _id: deviceId, userId };
  if (workspaceId) {
    query.$or = [
      { workspaceId },
      { workspaceId: null },
      { workspaceId: { $exists: false } },
    ];
  }
  return CompanionDeviceModel.findOneAndUpdate(query, updates, {
    new: true,
    runValidators: true,
  }).exec();
};

/** Active devices whose month is over (devices paired before expiry existed count from the day they were paired). */
export const findExpiredCompanionDevices = async (
  now: Date,
  lifetimeMs: number,
): Promise<ICompanionDeviceDocument[]> =>
  CompanionDeviceModel.find({
    status: "active",
    $or: [
      { expiresAt: { $lte: now } },
      {
        expiresAt: null,
        createdAt: { $lte: new Date(now.getTime() - lifetimeMs) },
      },
    ],
  })
    .limit(500)
    .exec();

export const revokeCompanionDeviceById = async (
  deviceId: string,
  revokedAt: Date,
): Promise<void> => {
  await CompanionDeviceModel.updateOne(
    { _id: deviceId, status: { $ne: "revoked" } },
    { status: "revoked", revokedAt },
  ).exec();
};
