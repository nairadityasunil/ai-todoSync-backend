import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Response } from "express";

import { clearAuthCookies, setAuthCookies } from "./auth-cookies.js";
import type { AuthResult } from "../../types/auth.js";

const result = {
  token: "t",
  accessToken: "a",
  refreshToken: "r",
  accessTokenExpiresIn: 900,
  refreshTokenExpiresIn: 2592000,
} as unknown as AuthResult;

const capture = (): {
  res: Response;
  cookies: Array<{ name: string; options: Record<string, unknown> }>;
} => {
  const cookies: Array<{ name: string; options: Record<string, unknown> }> = [];
  const res = {
    cookie: (name: string, _v: string, options: Record<string, unknown>) =>
      cookies.push({ name, options }),
    clearCookie: (name: string, options: Record<string, unknown>) =>
      cookies.push({ name, options }),
  } as unknown as Response;
  return { res, cookies };
};

describe("auth cookie attributes", () => {
  const saved = {
    s: process.env.COOKIE_SECURE,
    ss: process.env.COOKIE_SAMESITE,
  };
  afterEach(() => {
    process.env.COOKIE_SECURE = saved.s;
    process.env.COOKIE_SAMESITE = saved.ss;
    if (saved.s === undefined) delete process.env.COOKIE_SECURE;
    if (saved.ss === undefined) delete process.env.COOKIE_SAMESITE;
  });

  it("cross-site HTTPS cookies are HttpOnly, Secure, SameSite=None and Partitioned", () => {
    process.env.COOKIE_SECURE = "true";
    process.env.COOKIE_SAMESITE = "none";
    const { res, cookies } = capture();
    setAuthCookies(res, result);
    assert.ok(cookies.length >= 2);
    for (const c of cookies) {
      assert.equal(c.options.httpOnly, true);
      assert.equal(c.options.secure, true);
      assert.equal(c.options.sameSite, "none");
      assert.equal(c.options.partitioned, true);
    }
  });

  it("clearing uses the same attributes, which browsers require for a partitioned cookie", () => {
    process.env.COOKIE_SECURE = "true";
    process.env.COOKIE_SAMESITE = "none";
    const { res, cookies } = capture();
    clearAuthCookies(res);
    assert.ok(cookies.length >= 1);
    for (const c of cookies) assert.equal(c.options.partitioned, true);
  });

  it("local http development cookies are not partitioned", () => {
    process.env.COOKIE_SECURE = "false";
    process.env.COOKIE_SAMESITE = "lax";
    const { res, cookies } = capture();
    setAuthCookies(res, result);
    for (const c of cookies) {
      assert.equal(c.options.partitioned, undefined);
      assert.equal(c.options.sameSite, "lax");
    }
  });
});
