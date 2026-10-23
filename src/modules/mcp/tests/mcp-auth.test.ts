import assert from "node:assert/strict";
import test, { describe } from "node:test";
import "../mcp.server.js"; // Bootstraps and imports all tool modules into toolRegistry
import toolRegistry from "../registry/tool-registry.js";
import { validateInput } from "../validation/schema-validator.js";
import {
  checkConfirmation,
  createMemoryConfirmationStore,
  setConfirmationStore,
} from "../registry/risk-policy.js";
import { McpError } from "../errors/mcp-error.js";

describe("MCP Auth, Registry & Validation Tests", () => {
  test("toolRegistry lists registered tools and filtering works", () => {
    const tools = toolRegistry.listEntries();
    assert.ok(tools.length > 0, "Expected registered tools in registry");

    const manifest = toolRegistry.listManifest();
    assert.ok(manifest.length > 0, "Manifest should return array of tools");
    assert.ok(manifest[0].name, "Manifest item should have name");
    assert.ok(manifest[0].description, "Manifest item should have description");
  });

  test("schemaValidator validates correct inputs and rejects invalid ones", () => {
    const schema = {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
    };

    const validResult = validateInput(schema, {
      taskId: "task-123",
      limit: 10,
    });
    assert.equal(validResult.valid, true);
    assert.equal(validResult.errors.length, 0);

    const invalidResult = validateInput(schema, { limit: 100 });
    assert.equal(invalidResult.valid, false);
    assert.ok(invalidResult.errors.length > 0);
  });

  test("checkConfirmation handles confirmation token generation and validation", async () => {
    const toolEntry = {
      name: "task:delete",
      description: "Delete task",
      domain: "task",
      inputSchema: { type: "object" },
      requiredScope: "work:write" as const,
      risk: "destructive" as const,
      requiresConfirmation: true,
      handler: async () => ({ deleted: true }),
    };

    setConfirmationStore(createMemoryConfirmationStore());
    const checkResult = await checkConfirmation(toolEntry, "user-1", {});
    assert.ok(checkResult !== null, "Should return confirmation payload");
    assert.equal(checkResult?.confirmationRequired, true);
    assert.ok(
      checkResult?.confirmationToken,
      "Should generate confirmation token",
    );

    const validTokenResult = await checkConfirmation(toolEntry, "user-1", {
      _confirmationToken: checkResult?.confirmationToken,
    });
    assert.equal(
      validTokenResult,
      null,
      "Call with valid token should proceed",
    );

    const invalidTokenResult = await checkConfirmation(toolEntry, "user-1", {
      _confirmationToken: "invalid-token",
    });
    assert.ok(
      invalidTokenResult !== null,
      "Call with invalid token should be rejected",
    );
  });

  test("McpError generates correct status code and JSON format", () => {
    const error = new McpError("not_found", "Task task-999 not found");
    assert.equal(error.httpStatus, 404);
    assert.equal(error.code, "not_found");
  });
});
