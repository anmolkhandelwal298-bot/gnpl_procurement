/* Applies db/migrations/*.sql in order, each inside a transaction, tracked in schema_migrations.
 *   npm run db:migrate               apply pending migrations
 *   tsx scripts/migrate.ts --reset   DEV ONLY: drop and recreate the public schema first
 * Needs MIGRATION_DATABASE_URL (owner role). APP_DB_PASSWORD sets the grainspan_app login password. */
import { ownerClient, runMigrations, setAppRolePassword } from "./lib/setup";

try { process.loadEnvFile(".env"); } catch { /* optional */ }

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set");
  const c = ownerClient(url);
  await c.connect();
  try {
    const applied = await runMigrations(c, { reset: process.argv.includes("--reset"), log: (m) => console.log(m) });
    if (!applied.length) console.log("no pending migrations");
    if (process.env.APP_DB_PASSWORD) { await setAppRolePassword(c, process.env.APP_DB_PASSWORD); console.log("grainspan_app login password set"); }
    else console.log("APP_DB_PASSWORD not set: grainspan_app remains NOLOGIN (set it before running the app)");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
