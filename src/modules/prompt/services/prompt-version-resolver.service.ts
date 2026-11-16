import PromptVersionModel, {
  type IPromptVersionDocument,
} from "../models/prompt-version.model.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptCanaryDeploymentModel from "../models/prompt-canary-deployment.model.js";
import { HttpError } from "../../../shared/errors/http-error.js";

export interface ResolvedPromptVersionResult {
  version: IPromptVersionDocument;
  versionNumber: number;
  isProduction: boolean;
  isCanary: boolean;
  canaryDeploymentId?: string | null;
}

export class PromptVersionResolverService {
  /**
   * Resolves active production or canary version for execution.
   */
  public async resolveVersion(
    promptId: string,
    options: { isProduction?: boolean; requestedVersion?: number } = {},
  ): Promise<ResolvedPromptVersionResult> {
    const { requestedVersion } = options;
    // Versions and canaries belong to the root prompt, whichever copy of it the caller holds.
    const library = await PromptLibraryModel.findById(promptId)
      .select("parentId")
      .lean();
    if (library?.parentId) promptId = String(library.parentId);

    // 1. If explicit version requested
    if (
      requestedVersion !== undefined &&
      requestedVersion !== null &&
      requestedVersion > 0
    ) {
      const versionDoc = await PromptVersionModel.findOne({
        promptId,
        version: requestedVersion,
      });
      if (!versionDoc) {
        throw new HttpError(
          404,
          `Prompt version ${requestedVersion} not found`,
        );
      }
      return {
        version: versionDoc,
        versionNumber: versionDoc.version,
        isProduction: versionDoc.environment === "production",
        isCanary: false,
        canaryDeploymentId: null,
      };
    }

    // 2. Check active canary deployment
    const activeCanary = await PromptCanaryDeploymentModel.findOne({
      promptId,
      status: "active",
    });

    if (activeCanary) {
      const rand = Math.random() * 100;
      const selectCanary = rand < activeCanary.trafficWeight.canary;
      const targetVersionNumber = selectCanary
        ? activeCanary.candidateVersion
        : activeCanary.legacyVersion;

      const versionDoc = await PromptVersionModel.findOne({
        promptId,
        version: targetVersionNumber,
      });

      if (versionDoc) {
        return {
          version: versionDoc,
          versionNumber: targetVersionNumber,
          isProduction: !selectCanary,
          isCanary: selectCanary,
          canaryDeploymentId: (activeCanary._id as any).toString(),
        };
      }
    }

    // 3. Resolve Production version
    let prodVersionDoc = await PromptVersionModel.findOne({
      promptId,
      environment: "production",
    }).sort({ version: -1 });

    if (!prodVersionDoc) {
      const root = await PromptLibraryModel.findById(promptId);
      if (root && root.productionVersion) {
        prodVersionDoc = await PromptVersionModel.findOne({
          promptId,
          version: root.productionVersion,
        });
      }
    }

    if (!prodVersionDoc) {
      prodVersionDoc = await PromptVersionModel.findOne({
        promptId,
      }).sort({ version: -1 });
    }

    if (!prodVersionDoc) {
      throw new HttpError(404, `No version found for prompt ${promptId}`);
    }

    return {
      version: prodVersionDoc,
      versionNumber: prodVersionDoc.version,
      isProduction: true,
      isCanary: false,
      canaryDeploymentId: null,
    };
  }
}

export default new PromptVersionResolverService();
