/* One-command production start, for hosts where you cannot run shell commands (Render, Railway, Fly, …).
 *
 *   1. connects to the database with the OWNER url (MIGRATION_DATABASE_URL) and applies pending migrations
 *   2. (re)sets the password of the restricted runtime role `grainspan_app` — derived from SESSION_SECRET unless APP_DB_PASSWORD is set
 *   3. optional: creates the first administrator       (BOOTSTRAP_ADMIN_EMAIL / _NAME / _PASSWORD; only if no admin exists yet)
 *   4. optional: loads DEMO data for a prototype        (SEED_DEMO=true)
 *   5. starts the web server with DATABASE_URL pointing at the restricted role, so Row Level Security stays in force
 *
 * If MIGRATION_DATABASE_URL is not set but DATABASE_URL is, steps 1–4 are skipped (you manage the database yourself). */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createAdmin, DEMO_ACCOUNTS, ownerClient, runMigrations, seedDemo, setAppRolePassword } from "./lib/setup";

const log = (m: string) => console.log(`[boot] ${m}`);
const env = process.env;

function die(msg: string): never { console.error(`\n[boot] ❌ ${msg}\n`); process.exit(1); }

async function connectWithRetry(url: string) {
  let last: unknown;
  for (let i = 1; i <= 20; i++) {
    const c = ownerClient(url);
    try { await c.connect(); return c; } catch (e) { last = e; await c.end().catch(() => undefined); log(`database not reachable yet (${(e as Error).message}); retry ${i}/20`); await new Promise((r) => setTimeout(r, 3000)); }
  }
  die(`cannot connect to the database: ${(last as Error).message}`);
}

async function main() {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) die("SESSION_SECRET must be set to at least 32 characters (any long random string).");

  const owner = env.MIGRATION_DATABASE_URL;
  if (owner) {
    const appPassword = env.APP_DB_PASSWORD || createHmac("sha256", env.SESSION_SECRET).update("grainspan-app-db-password").digest("hex");
    const c = await connectWithRetry(owner);
    try {
      try {
        const applied = await runMigrations(c, { log });
        log(applied.length ? `database ready (${applied.length} migration(s) applied)` : "database up to date");
        await setAppRolePassword(c, appPassword);
      } catch (e) {
        const m = (e as Error).message;
        if (/permission denied to (create|alter) role|must be superuser|permission denied for database|must have createrole/i.test(m)) {
          die(`${m}\n\n  The database user in MIGRATION_DATABASE_URL is not allowed to create / manage the restricted runtime role (grainspan_app).\n  Use a Postgres provider whose default user can create roles (Neon, Supabase, or a self-hosted/ managed instance), or ask your provider to enable CREATEROLE for that user.\n  See docs/DEPLOY-MVP.md, "If the database refuses to create a role".`);
        }
        throw e;
      }
      if (env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD) {
        const r = await createAdmin(c, { email: env.BOOTSTRAP_ADMIN_EMAIL, name: env.BOOTSTRAP_ADMIN_NAME || "Administrator", password: env.BOOTSTRAP_ADMIN_PASSWORD, ifMissing: true });
        log(r === "skipped" ? "administrator already exists — bootstrap skipped" : `administrator ${env.BOOTSTRAP_ADMIN_EMAIL} ${r} (must change password at first sign-in)`);
      }
      if (env.SEED_DEMO === "true") {
        await seedDemo(c, env.SEED_PASSWORD || "Demo@12345");
        log("DEMO data loaded (accounts: " + DEMO_ACCOUNTS.map((a) => a[1]).join(", ") + ")");
      }
    } finally { await c.end(); }

    if (!env.DATABASE_URL) {                                      // runtime connection = restricted role on the same database
      const u = new URL(owner);
      u.username = "grainspan_app"; u.password = appPassword;
      env.DATABASE_URL = u.toString();
    }
  } else if (!env.DATABASE_URL) {
    die("Set MIGRATION_DATABASE_URL (owner connection; the app sets itself up) or DATABASE_URL (already prepared database).");
  }

  // verify the runtime role works and is NOT able to bypass RLS before accepting traffic
  const probe = ownerClient(env.DATABASE_URL!);
  try {
    await probe.connect();
    const r = await probe.query("select current_user as u, (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as bypass");
    if (r.rows[0].bypass) die(`DATABASE_URL connects as "${r.rows[0].u}", which can bypass Row Level Security. Use the restricted grainspan_app role.`);
    log(`runtime database role: ${r.rows[0].u} (RLS enforced)`);
  } catch (e) {
    die(`the restricted runtime role cannot connect: ${(e as Error).message}\n  Check DATABASE_SSL (use "no-verify" if your provider's certificate cannot be verified) and, for connection poolers, that the username format matches your provider.`);
  } finally { await probe.end().catch(() => undefined); }

  env.APP_URL = env.APP_URL || env.RENDER_EXTERNAL_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "") || `http://localhost:${env.PORT || 3000}`;
  if (env.COOKIE_SECURE === undefined) env.COOKIE_SECURE = env.APP_URL.startsWith("https://") ? "true" : "false";
  (env as Record<string, string | undefined>).NODE_ENV = "production";
  const port = env.PORT || "3000";
  log(`starting web server on :${port} (APP_URL=${env.APP_URL})`);
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", port, "-H", "0.0.0.0"], { stdio: "inherit", env });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 0));
}
main().catch((e) => die((e as Error).stack ?? String(e)));
