/**
 * Creates the platform super admin, or makes an existing account one. Run: npm run seed:super-admin
 *
 * Give the values as environment variables:
 *   SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' SUPER_ADMIN_NAME='Your Name' npm run seed:super-admin
 * or as flags:
 *   npm run seed:super-admin -- --email you@example.com --password 'a long password' --name 'Your Name'
 *
 * - A new account is created with that password and a default workspace.
 * - An existing account is promoted and re-activated; its password is only changed when you add --reset-password
 *   (or SUPER_ADMIN_RESET_PASSWORD=true).
 * - Safe to run again. The password is never printed or logged.
 */
import mongoose from "mongoose";

import { connectDatabase, disconnectDatabase } from "../config/db.config.js";

const flag = (name: string): string | undefined => {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--"))
    return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
};
const has = (name: string): boolean =>
  process.argv.slice(2).includes(`--${name}`);

const email = (flag("email") ?? process.env.SUPER_ADMIN_EMAIL ?? "")
  .trim()
  .toLowerCase();
const password = flag("password") ?? process.env.SUPER_ADMIN_PASSWORD ?? "";
const name = (flag("name") ?? process.env.SUPER_ADMIN_NAME ?? "").trim();
const resetPassword =
  has("reset-password") || process.env.SUPER_ADMIN_RESET_PASSWORD === "true";

const fail = (message: string): never => {
  process.stderr.write(`seed:super-admin: ${message}\n`);
  process.exit(1);
};

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  fail("give a valid email: SUPER_ADMIN_EMAIL or --email");

// Loading the app registers every model and service the user setup needs.
await import("../app.js");
await connectDatabase();
const { default: UserModel } =
  await import("../modules/auth/models/user.model.js");

let outcome: string;
const existing = await UserModel.findOne({ email });
if (existing) {
  existing.platformRole = "super_admin";
  existing.accountStatus = "active";
  if (resetPassword) {
    if (password.length < 8) fail("a password needs at least 8 characters");
    existing.password = password;
  }
  await existing.save();
  outcome = resetPassword
    ? `${email} is now a super admin and the password was reset`
    : `${email} is now a super admin (password unchanged)`;
} else {
  if (password.length < 8)
    fail(
      "give a password of at least 8 characters: SUPER_ADMIN_PASSWORD or --password",
    );
  const parts = name.split(/\s+/).filter(Boolean);
  const user = await UserModel.create({
    email,
    password,
    name: name || null,
    firstName: parts[0] ?? null,
    lastName: parts.slice(1).join(" ") || null,
    authProvider: "local",
    platformRole: "super_admin",
  });
  try {
    const { default: workspaces } =
      await import("../modules/workspace/services/workspace.service.js");
    await workspaces.getOrCreateDefaultWorkspace(String(user._id));
  } catch {
    // the account gets its workspace on first sign-in if this fails
  }
  outcome = `${email} was created as a super admin`;
}

process.stdout.write(`${outcome}\n`);
await disconnectDatabase();
await mongoose.disconnect().catch(() => undefined);
process.exit(0);
