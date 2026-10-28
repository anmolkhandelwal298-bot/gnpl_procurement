/* Applies db/migrations/*.sql in order, each inside a transaction, tracked in schema_migrations.
 *   npm run db:migrate            apply pending migrations
 *   tsx scripts/migrate.ts --reset   DEV ONLY: drop and recreate the public schema first
 * Needs MIGRATION_DATABASE_URL (owner/superuser-like role). APP_DB_PASSWORD sets the grainspan_app login password. */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

try { process.loadEnvFile(".env"); } catch { /* optional */ }

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set");
  const reset = process.argv.includes("--reset");
  if (reset && process.env.NODE_ENV === "production") throw new Error("--reset is refused in production");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (reset) {
      await client.query("drop schema public cascade; create schema public;");
      console.log("schema reset");
    }
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const dir = path.join(process.cwd(), "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      process.stdout.write(`applying ${f} ... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values ($1)", [f]);
        await client.query("commit");
        console.log("ok");
      } catch (e) {
        await client.query("rollback");
        console.log("FAILED");
        throw e;
      }
    }
    const pw = process.env.APP_DB_PASSWORD;
    if (pw) {
      await client.query(`alter role grainspan_app with login password ${client.escapeLiteral(pw)}`);
      console.log("grainspan_app login password set");
    } else {
      console.log("APP_DB_PASSWORD not set: grainspan_app remains NOLOGIN (set it before running the app)");
    }
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
