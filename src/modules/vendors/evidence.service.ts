import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import mongoose, { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import {
  VendorEvidenceModel,
  type EvidenceKind,
  type IVendorDocument,
  type IVendorEvidenceDocument,
} from "./model.js";

/**
 * Vendor evidence (SOC 2 reports, DPAs, certificates) in MongoDB GridFS:
 * no extra infrastructure, replicated and backed up with the database.
 * Uploads are limited to document and image types whose content matches the
 * declared type, and are always served as attachments.
 */

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;
const BUCKET = "vendorEvidence";
/** Per vendor, so one vendor cannot fill the database. */
export const MAX_EVIDENCE_PER_VENDOR = 50;

const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** Allowed types and the bytes their content must start with. */
const ALLOWED: Record<string, { ext: string; magic: number[] | null }> = {
  "application/pdf": { ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    ext: "docx",
    magic: ZIP,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    ext: "xlsx",
    magic: ZIP,
  },
  "text/plain": { ext: "txt", magic: null },
  "text/csv": { ext: "csv", magic: null },
};
export const ALLOWED_EVIDENCE_TYPES = Object.keys(ALLOWED);

/** Whether the content looks like the declared type. */
export function contentMatches(contentType: string, body: Buffer): boolean {
  const rule = ALLOWED[contentType];
  if (!rule) return false;
  if (rule.magic) return rule.magic.every((byte, i) => body[i] === byte);
  // Text: no NUL bytes in the first 8 KB (binary disguised as text).
  return !body.subarray(0, 8192).includes(0);
}

/** A file name safe for storage and Content-Disposition. */
export function safeFileName(raw: string, contentType: string): string {
  const ext = ALLOWED[contentType]?.ext ?? "bin";
  const base = raw
    .replace(/\.[^.]*$/, "")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return `${base || "evidence"}.${ext}`;
}

const bucket = () => {
  const db = mongoose.connection.db;
  if (!db) throw new AppError(503, "Storage is not available", "UNAVAILABLE");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
};

class EvidenceService {
  public async upload(input: {
    vendor: IVendorDocument;
    userId: string;
    body: Buffer;
    contentType: string;
    fileName: string;
    kind: EvidenceKind;
    expiresAt: Date | null;
  }): Promise<IVendorEvidenceDocument> {
    const contentType = input.contentType.split(";")[0].trim().toLowerCase();
    if (!ALLOWED[contentType])
      throw new AppError(
        415,
        "Upload a PDF, Word or Excel file, an image or plain text",
        "UNSUPPORTED_MEDIA_TYPE",
      );
    if (!input.body.length)
      throw new AppError(400, "The file is empty", "BAD_REQUEST");
    if (input.body.length > MAX_EVIDENCE_BYTES)
      throw new AppError(413, "Files can be up to 15 MB", "PAYLOAD_TOO_LARGE");
    if (!contentMatches(contentType, input.body))
      throw new AppError(
        415,
        "The file's content does not match its type",
        "UNSUPPORTED_MEDIA_TYPE",
      );
    const count = await VendorEvidenceModel.countDocuments({
      vendorId: input.vendor._id,
    });
    if (count >= MAX_EVIDENCE_PER_VENDOR)
      throw new AppError(
        409,
        `A vendor can have up to ${MAX_EVIDENCE_PER_VENDOR} files; delete old ones first`,
        "CONFLICT",
      );

    const name = safeFileName(input.fileName, contentType);
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    const fileId = new Types.ObjectId();
    await new Promise<void>((resolve, reject) => {
      Readable.from([input.body])
        .pipe(
          bucket().openUploadStreamWithId(fileId, name, {
            metadata: {
              vendorId: input.vendor._id,
              workspaceId: input.vendor.workspaceId,
              contentType,
            },
          }),
        )
        .on("finish", () => resolve())
        .on("error", reject);
    });
    try {
      return await VendorEvidenceModel.create({
        workspaceId: input.vendor.workspaceId,
        vendorId: input.vendor._id,
        kind: input.kind,
        name,
        fileId,
        contentType,
        size: input.body.length,
        sha256,
        expiresAt: input.expiresAt,
        uploadedBy: input.userId,
      });
    } catch (error) {
      // Do not leave an orphaned file behind.
      await bucket()
        .delete(fileId)
        .catch(() => undefined);
      throw error;
    }
  }

  public stream(evidence: IVendorEvidenceDocument) {
    return bucket().openDownloadStream(evidence.fileId);
  }

  public async remove(evidence: IVendorEvidenceDocument): Promise<void> {
    await evidence.deleteOne();
    await bucket()
      .delete(evidence.fileId)
      .catch(() => undefined);
  }

  /** Deletes every file of a vendor (when the vendor is deleted). */
  public async removeAll(vendorId: Types.ObjectId | string): Promise<void> {
    const items = await VendorEvidenceModel.find({ vendorId });
    for (const item of items) await this.remove(item);
  }
}

export default new EvidenceService();
