import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import mongoose from "mongoose";
import promptLibraryService from "./prompt.service.js";
import promptVersionResolverService from "./prompt-version-resolver.service.js";
import promptCanaryService from "./prompt-canary.service.js";
import PromptLibraryModel from "../models/prompt-library.model.js";
import PromptVersionModel from "../models/prompt-version.model.js";
import PromptCanaryDeploymentModel from "../models/prompt-canary-deployment.model.js";
import workspaceService from "../../workspace/services/workspace.service.js";

describe("Prompt Version Environment & Deployment Lifecycle Tests", () => {
  const dummyWorkspaceId = new mongoose.Types.ObjectId().toString();
  const dummyUserId = new mongoose.Types.ObjectId().toString();
  let createdPromptId: string;

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGO_URI || "mongodb://127.0.0.1:27017/sync-todo-test",
      );
    }
    // Mock Workspace membership
    workspaceService.assertMembership = async () => ({}) as any;
  });

  after(async () => {
    if (createdPromptId) {
      await PromptLibraryModel.findByIdAndDelete(createdPromptId);
      await PromptVersionModel.deleteMany({ promptId: createdPromptId });
      await PromptCanaryDeploymentModel.deleteMany({
        promptId: createdPromptId,
      });
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test("1. Creating a prompt initializes Version 1 with development environment", async () => {
    const prompt = await promptLibraryService.createPrompt(
      dummyWorkspaceId,
      dummyUserId,
      {
        name: "Deployment Test Prompt",
        body: "Initial prompt body {{ input }}",
        variables: [{ name: "input", required: true }],
        category: "testing",
      },
    );

    createdPromptId = prompt._id.toString();
    assert.ok(createdPromptId, "Prompt ID must exist");

    const v1 = await PromptVersionModel.findOne({
      promptId: createdPromptId,
      version: 1,
    });
    assert.ok(v1, "Version 1 doc must exist");
    assert.equal(v1.environment, "development");
  });

  test("2. Moving Version 1 to staging updates environment to staging", async () => {
    const v1Staging = await promptLibraryService.moveToStaging(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      1,
    );

    assert.equal(v1Staging.environment, "staging");
  });

  test("3. Directly deploying Version 1 sets v1 to production", async () => {
    const deployed = await promptLibraryService.deployDirectToProduction(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      1,
    );

    assert.equal(deployed.productionVersion, 1);

    const v1Doc = await PromptVersionModel.findOne({
      promptId: createdPromptId,
      version: 1,
    });
    assert.equal(v1Doc?.environment, "production");

    // Single production version check
    const prodDocsCount = await PromptVersionModel.countDocuments({
      promptId: createdPromptId,
      environment: "production",
    });
    assert.equal(
      prodDocsCount,
      1,
      "Exactly one version can be marked production",
    );
  });

  test("4. Creating Version 2 and directly deploying v2 demotes v1 to staging", async () => {
    await promptLibraryService.updatePrompt(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      { body: "Version 2 prompt body {{ input }}" },
    );

    const v2Doc = await PromptVersionModel.findOne({
      promptId: createdPromptId,
      version: 2,
    });
    assert.ok(v2Doc, "Version 2 doc should exist");

    // Directly deploy v2
    await promptLibraryService.deployDirectToProduction(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      2,
    );

    const [v1After, v2After] = await Promise.all([
      PromptVersionModel.findOne({ promptId: createdPromptId, version: 1 }),
      PromptVersionModel.findOne({ promptId: createdPromptId, version: 2 }),
    ]);

    assert.equal(
      v1After?.environment,
      "staging",
      "v1 must be demoted to staging",
    );
    assert.equal(
      v2After?.environment,
      "production",
      "v2 must be promoted to production",
    );

    const prodDocsCount = await PromptVersionModel.countDocuments({
      promptId: createdPromptId,
      environment: "production",
    });
    assert.equal(
      prodDocsCount,
      1,
      "Exactly one version can be marked production",
    );
  });

  test("5. Starting Canary Deployment for Version 3 starts Phase 1 rollout", async () => {
    await promptLibraryService.updatePrompt(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      { body: "Version 3 candidate body {{ input }}" },
    );

    const canary = await promptLibraryService.startCanary(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      { candidateVersion: 3, minRequests: 5, errorThreshold: 0.1 },
    );

    assert.equal(canary.status, "active");
    assert.equal(canary.currentPhase, 1);
    assert.equal(canary.trafficWeight.canary, 5);
    assert.equal(canary.legacyVersion, 2);
    assert.equal(canary.candidateVersion, 3);
  });

  test("6. Version Resolver returns v2 or v3 during active canary", async () => {
    const resolved = await promptVersionResolverService.resolveVersion(
      createdPromptId,
      { isProduction: true },
    );

    assert.ok([2, 3].includes(resolved.versionNumber));
    assert.ok(resolved.version.body);
  });

  test("7. Advancing Canary rollout phases to completion promotes candidate v3", async () => {
    await promptLibraryService.advanceCanary(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
    ); // Phase 2 (25%)
    await promptLibraryService.advanceCanary(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
    ); // Phase 3 (50%)
    await promptLibraryService.advanceCanary(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
    ); // Phase 4 (100%)

    const completed = await promptLibraryService.completeCanary(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
    );

    assert.equal(completed.status, "completed");

    const [v2Final, v3Final] = await Promise.all([
      PromptVersionModel.findOne({ promptId: createdPromptId, version: 2 }),
      PromptVersionModel.findOne({ promptId: createdPromptId, version: 3 }),
    ]);

    assert.equal(v2Final?.environment, "staging", "v2 demoted to staging");
    assert.equal(
      v3Final?.environment,
      "production",
      "v3 promoted to production",
    );
  });

  test("8. Automated Canary rollback triggers when error threshold is exceeded", async () => {
    // Create Version 4
    await promptLibraryService.updatePrompt(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      { body: "Version 4 faulty body {{ input }}" },
    );

    const canary = await promptLibraryService.startCanary(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      { candidateVersion: 4, minRequests: 3, errorThreshold: 0.2 },
    );

    const canaryId = (canary._id as any).toString();

    // Record failing requests to exceed 20% error rate
    await promptCanaryService.recordExecutionMetrics(
      canaryId,
      true,
      true,
      120,
      10,
      0.001,
    );
    await promptCanaryService.recordExecutionMetrics(
      canaryId,
      true,
      true,
      110,
      10,
      0.001,
    );
    await promptCanaryService.recordExecutionMetrics(
      canaryId,
      true,
      true,
      130,
      10,
      0.001,
    );

    const canaryAfter = await PromptCanaryDeploymentModel.findById(canaryId);
    assert.equal(
      canaryAfter?.status,
      "failed",
      "Canary must fail automatically on high error rate",
    );
    assert.ok(canaryAfter?.rollbackReason?.includes("Automated rollback"));

    // Verify v3 remains active production version
    const resolved = await promptVersionResolverService.resolveVersion(
      createdPromptId,
      { isProduction: true },
    );
    assert.equal(
      resolved.versionNumber,
      3,
      "Production must remain legacy v3 after failed canary",
    );
  });

  test("9. Version in staging can be moved back to development", async () => {
    // Version 2 was demoted to staging in earlier test
    const v2Before = await PromptVersionModel.findOne({
      promptId: createdPromptId,
      version: 2,
    });
    assert.equal(v2Before?.environment, "staging");

    const demotedV2 = await promptLibraryService.moveToDevelopment(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      2,
    );

    assert.equal(demotedV2.environment, "development");

    const v2After = await PromptVersionModel.findOne({
      promptId: createdPromptId,
      version: 2,
    });
    assert.equal(v2After?.environment, "development");
  });

  test("10. Production rollback goes back to the previous production version and records why", async () => {
    // History so far: v1 (direct), v2 (direct), v3 (canary). Production is v3.
    const result = await promptLibraryService.rollbackProduction(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
      { reason: "Answers got worse" },
    );
    assert.equal(result.rolledBackFrom, 3);
    assert.equal(result.productionVersion, 2, "previous production version");

    const versions = await PromptVersionModel.find({
      promptId: createdPromptId,
    });
    const env = Object.fromEntries(
      versions.map((v) => [v.version, v.environment]),
    );
    assert.equal(env[2], "production");
    assert.equal(env[3], "staging");
    const library = await PromptLibraryModel.findById(createdPromptId);
    assert.equal(library?.productionVersion, 2);

    const history = await promptLibraryService.getDeploymentHistory(
      dummyWorkspaceId,
      dummyUserId,
      createdPromptId,
    );
    assert.equal(history.productionVersion, 2);
    assert.equal(history.history[0].action, "rolled_back");
    assert.equal(history.history[0].reason, "Answers got worse");
    assert.ok(history.history.some((e) => e.action === "canary_completed"));
    assert.ok(history.history.some((e) => e.action === "canary_failed"));
  });

  test("11. Production rollback refuses the current version, unknown versions and a missing history", async () => {
    await assert.rejects(
      promptLibraryService.rollbackProduction(
        dummyWorkspaceId,
        dummyUserId,
        createdPromptId,
        { toVersion: 2 },
      ),
      /already in production/,
    );
    await assert.rejects(
      promptLibraryService.rollbackProduction(
        dummyWorkspaceId,
        dummyUserId,
        createdPromptId,
        { toVersion: 99 },
      ),
      /not found/,
    );
    await assert.rejects(
      promptLibraryService.rollbackProduction(
        dummyWorkspaceId,
        dummyUserId,
        createdPromptId,
        { toVersion: 0 },
      ),
      /version number/,
    );
  });

  test("12. A canary is found from any document of the prompt, not only the first one", async () => {
    // Every edit makes a new library document; the portal holds the newest one's id.
    const child = await PromptLibraryModel.create({
      workspaceId: dummyWorkspaceId,
      name: "child document",
      slug: `child-${Date.now()}`,
      body: "child",
      version: 9,
      parentId: createdPromptId,
      createdBy: dummyUserId,
      updatedBy: dummyUserId,
    } as never);
    try {
      await promptCanaryService.startCanary(
        dummyWorkspaceId,
        dummyUserId,
        createdPromptId,
        { candidateVersion: 3 },
      );
      const seen = new Set<number>();
      await PromptCanaryDeploymentModel.updateOne(
        { promptId: createdPromptId, status: "active" },
        { $set: { "trafficWeight.canary": 100, "trafficWeight.legacy": 0 } },
      );
      for (let i = 0; i < 10; i++) {
        const resolved = await promptVersionResolverService.resolveVersion(
          String(child._id),
        );
        seen.add(resolved.versionNumber);
        assert.equal(resolved.isCanary, true);
        assert.ok(resolved.canaryDeploymentId);
      }
      assert.deepEqual([...seen], [3]);
    } finally {
      await PromptLibraryModel.findByIdAndDelete(child._id);
      await PromptCanaryDeploymentModel.updateMany(
        { promptId: createdPromptId, status: "active" },
        { $set: { status: "cancelled" } },
      );
    }
  });
});
