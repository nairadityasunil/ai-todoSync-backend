import mongoose from "mongoose";
import ProjectModel from "../modules/project/models/project.model.js";

const idToUuidCache = new Map<string, string>();
const uuidToIdCache = new Map<string, string>();

export const getCachedProjectUuid = (
  idOrUuid: string | null | undefined,
): string | null => {
  if (!idOrUuid || typeof idOrUuid !== "string") return null;
  const trimmed = idOrUuid.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return idToUuidCache.get(trimmed) ?? null;
};

/**
 * Resolves any project identifier (UUID or ObjectId string) into the underlying
 * MongoDB ObjectId string so that database queries and Mongoose models succeed.
 */
export const resolveProjectObjectId = async (
  idOrUuid: string | null | undefined,
): Promise<string | null> => {
  if (!idOrUuid || typeof idOrUuid !== "string") return null;
  const trimmed = idOrUuid.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;

  const cached = uuidToIdCache.get(trimmed);
  if (cached) return cached;

  if (mongoose.Types.ObjectId.isValid(trimmed)) {
    uuidToIdCache.set(trimmed, trimmed);
    return trimmed;
  }

  // Not a 24-hex ObjectId: resolve from Project model by uuid
  try {
    const project = await ProjectModel.findOne({ uuid: trimmed })
      .select("_id uuid")
      .lean()
      .exec();

    if (project) {
      const oid = project._id.toString();
      const uuid = project.uuid || oid;
      uuidToIdCache.set(trimmed, oid);
      uuidToIdCache.set(uuid, oid);
      idToUuidCache.set(oid, uuid);
      return oid;
    }
  } catch {
    // ignore lookup error
  }

  return null;
};

/**
 * Resolves any project identifier (ObjectId string or UUID) into the public
 * project UUID so that frontend clients receive consistent IDs matching project.id.
 */
export const resolveProjectUuid = async (
  idOrUuid: string | null | undefined,
): Promise<string | null> => {
  if (!idOrUuid || typeof idOrUuid !== "string") return null;
  const trimmed = idOrUuid.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;

  const cached = idToUuidCache.get(trimmed);
  if (cached) return cached;

  // Already a UUID
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    idToUuidCache.set(trimmed, trimmed);
    return trimmed;
  }

  if (mongoose.Types.ObjectId.isValid(trimmed)) {
    try {
      const project = await ProjectModel.findById(trimmed)
        .select("_id uuid")
        .lean()
        .exec();

      if (project) {
        const oid = project._id.toString();
        const uuid = project.uuid || oid;
        idToUuidCache.set(oid, uuid);
        uuidToIdCache.set(uuid, oid);
        return uuid;
      }
    } catch {
      // ignore lookup error
    }
  }

  return trimmed;
};

/**
 * Batch resolve project ObjectId strings to their public UUIDs for efficient list queries.
 */
export const buildProjectUuidMap = async (
  projectObjectIds: string[],
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  const missing: string[] = [];

  for (const id of projectObjectIds) {
    if (!id || typeof id !== "string") continue;
    if (idToUuidCache.has(id)) {
      map.set(id, idToUuidCache.get(id)!);
    } else if (mongoose.Types.ObjectId.isValid(id)) {
      missing.push(id);
    } else {
      map.set(id, id);
    }
  }

  if (missing.length > 0) {
    try {
      const projects = await ProjectModel.find({ _id: { $in: missing } })
        .select("_id uuid")
        .lean()
        .exec();

      for (const p of projects) {
        const oid = p._id.toString();
        const uuid = p.uuid || oid;
        idToUuidCache.set(oid, uuid);
        uuidToIdCache.set(uuid, oid);
        map.set(oid, uuid);
      }
    } catch {
      // ignore lookup error
    }
  }

  return map;
};
