/**
 * Writes the default email templates that are missing from the database. Run: npm run seed:email-templates
 * Never overwrites a template an admin has edited. (The app also adds missing ones the first time they are used.)
 */
import { connectDatabase, disconnectDatabase } from "../config/db.config.js";

await import("../app.js");
await connectDatabase();
const { ensureDefaultTemplates } =
  await import("../modules/email-templates/email-template.service.js");
const added = await ensureDefaultTemplates();
process.stdout.write(
  added
    ? `Added ${added} email template(s)\n`
    : "Every default email template already exists\n",
);
await disconnectDatabase();
process.exit(0);
