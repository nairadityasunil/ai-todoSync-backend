import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";

import { setCorsHeaders } from "./sdkAuth.middleware.js";

test("CORS allows every header the SDK sends on signed requests", () => {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as Response;

  setCorsHeaders(res, "https://app.example.com");

  const allowed = headers["access-control-allow-headers"]
    .split(",")
    .map((h) => h.trim().toLowerCase());
  for (const header of [
    "content-type",
    "x-sdk-key",
    "x-session-id",
    "x-timestamp",
    "x-nonce",
    "x-body-sha256",
    "x-signature",
    "x-signature-version",
    "x-api-key",
  ]) {
    assert.ok(allowed.includes(header), `${header} must be allowed`);
  }
  assert.equal(headers["access-control-max-age"], "7200");
});
