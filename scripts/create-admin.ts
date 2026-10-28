/* Creates (or resets) the first administrator in a fresh production database. The demo seed refuses to run in production, so this is the bootstrap.
 *
 *   ADMIN_EMAIL=you@grainspan.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-temporary-password1' npx tsx scripts/create-admin.ts
 *
 * Uses MIGRATION_DATABASE_URL (owner connection). The account must change its password at first sign-in. */
import { Client } from "pg";
import { hashPassword, passwordProblem } from "../src/lib/auth/password";

try { process.loadEnvFile(".env"); } catch { /* optional */ }

async function main() {
  const { ADMIN_EMAIL: email, ADMIN_NAME: name, ADMIN_PASSWORD: password, MIGRATION_DATABASE_URL: url } = process.env;
  if (!email || !name || !password || !url) throw new Error("Set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD and MIGRATION_DATABASE_URL");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const c = new Client({ connectionString: url, ssl: process.env.DATABASE_SSL && process.env.DATABASE_SSL !== "false" ? { rejectUnauthorized: process.env.DATABASE_SSL !== "no-verify" } : undefined });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.mode','system',true), set_config('app.user_id','00000000-0000-0000-0000-000000000001',true)");
    const p = await c.query(
      `insert into profiles(email, full_name, role) values ($1,$2,'admin')
       on conflict (lower(email)) do update set full_name = excluded.full_name, role = 'admin', is_active = true returning id`, [email.trim(), name.trim()]);
    await c.query(
      `insert into user_credentials(user_id, password_hash, must_change_password) values ($1,$2,true)
       on conflict (user_id) do update set password_hash = excluded.password_hash, must_change_password = true, failed_login_count = 0, locked_until = null, password_changed_at = now()`,
      [p.rows[0].id, await hashPassword(password)]);
    await c.query("commit");
    console.log(`Administrator ${email} is ready. They must change the password at first sign-in.`);
  } catch (e) { await c.query("rollback"); throw e; } finally { await c.end(); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
