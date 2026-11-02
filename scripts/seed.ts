/* Development seed: DEMO-labelled staff users, vendors and one DEMO RFQ (no bids). Refuses to run in production unless ALLOW_SEED=1.
 * Uses the owner connection (MIGRATION_DATABASE_URL). */
import { DEMO_ACCOUNTS, ownerClient, seedDemo } from "./lib/setup";

try { process.loadEnvFile(".env"); } catch { /* optional */ }

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") throw new Error("Refusing to seed in production (set ALLOW_SEED=1 to override)");
  const password = process.env.SEED_PASSWORD || "Demo@12345";
  const c = ownerClient(process.env.MIGRATION_DATABASE_URL!);
  await c.connect();
  try { await seedDemo(c, password); } finally { await c.end(); }
  console.log(`\nDEMO accounts (password for all: ${password})\n` + DEMO_ACCOUNTS.map(([r, e]) => `  ${e}  (${r})`).join("\n") + "\n  pending@vendor.demo (awaiting approval)");
}
main().catch((e) => { console.error(e); process.exit(1); });
