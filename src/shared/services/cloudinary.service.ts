import { v2 as cloudinary } from "cloudinary";
import env from "../../config/env.js";
import logger from "../../lib/logger.js";

if (
  env.CLOUDINARY_CLOUD_NAME &&
  env.CLOUDINARY_API_KEY &&
  env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    timeout: 60000,
  });
  logger.info("CloudinaryService initialized successfully");
} else {
  logger.warn("CloudinaryService: Missing configuration keys");
}

export interface CloudinaryUploadResult {
  publicId: string;
  secureUrl: string;
  resourceType: string;
  format?: string;
  bytes?: number;
}

export class CloudinaryService {
  /**
   * Upload base64 Data URI or buffer directly to Cloudinary infrastructure
   */
  public static async uploadDataUrl(
    dataUrl: string,
    folder = "pristine/chat",
    publicId?: string,
  ): Promise<CloudinaryUploadResult> {
    try {
      const result = await cloudinary.uploader.upload(dataUrl, {
        folder,
        resource_type: "auto",
        public_id: publicId,
      });

      return {
        publicId: result.public_id,
        secureUrl: result.secure_url || result.url,
        resourceType: result.resource_type,
        format: result.format,
        bytes: result.bytes,
      };
    } catch (error) {
      logger.error(
        "Cloudinary upload failed",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  /**
   * Delete asset from Cloudinary by public ID
   */
  public static async deleteAsset(
    publicId: string,
    resourceType: "image" | "raw" | "video" = "image",
  ): Promise<boolean> {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
      });
      return result.result === "ok";
    } catch (error) {
      logger.error(
        `Cloudinary delete asset failed for ${publicId}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }
  }
}

export default CloudinaryService;
