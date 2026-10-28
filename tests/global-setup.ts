import { execFileSync } from "node:child_process";
import { Client } from "pg";

/** Creates a pristine grainspan_test database and applies every migration to it before the suite runs. */
export default async function setup() {
  const admin = new Client({ connectionString: "postgres://postgres@127.0.0.1:54329/postgres" });
  await admin.connect();
  await admin.query("drop database if exists grainspan_test with (force)");
  await admin.query("create database grainspan_test");
  await admin.end();
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: "postgres://postgres@127.0.0.1:54329/grainspan_test",
      APP_DB_PASSWORD: "grainspan_app_dev",
    },
  });
}
