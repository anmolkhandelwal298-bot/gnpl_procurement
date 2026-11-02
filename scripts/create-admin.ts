/* Creates (or resets) an administrator.
 *   ADMIN_EMAIL=you@grainspan.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-temporary-password1' npx tsx scripts/create-admin.ts
 * Uses MIGRATION_DATABASE_URL (owner connection). The account must change its password at first sign-in. */
import { createAdmin, ownerClient } from "./lib/setup";

try { process.loadEnvFile(".env"); } catch { /* optional */ }

async function main() {
  const { ADMIN_EMAIL: email, ADMIN_NAME: name, ADMIN_PASSWORD: password, MIGRATION_DATABASE_URL: url } = process.env;
  if (!email || !name || !password || !url) throw new Error("Set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD and MIGRATION_DATABASE_URL");
  const c = ownerClient(url);
  await c.connect();
  try { await createAdmin(c, { email, name, password }); console.log(`Administrator ${email} is ready. They must change the password at first sign-in.`); } finally { await c.end(); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
