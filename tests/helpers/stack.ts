/** Boots a complete, isolated stack: fresh database + real `next start` server + mock email/WhatsApp provider APIs. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { Client as PgClient } from "pg";

export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 4010);
export const BASE = `http://127.0.0.1:${PORT}`;
export const RESEND_SECRET_B64 = Buffer.from("resend-webhook-signing-secret-for-tests").toString("base64");
export const WA_APP_SECRET = "wa-app-secret-for-tests";
export const WA_VERIFY = "wa-verify-token";
const DB = process.env.E2E_DB ?? "grainspan_api";
const PG = "postgres://postgres@127.0.0.1:54329";

export interface Captured { path: string; headers: http.IncomingHttpHeaders; body: any }
export class MockProviders {
  requests: Captured[] = [];
  /** per-provider behaviour: queue of HTTP statuses to return before falling back to success */
  failures: Record<"resend" | "meta", { status: number; body?: any }[]> = { resend: [], meta: [] };
  private n = 0;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {}; try { body = JSON.parse(raw); } catch { /* */ }
      this.requests.push({ path: req.url ?? "", headers: req.headers, body });
      const which = (req.url ?? "").startsWith("/resend") ? "resend" : "meta";
      const fail = this.failures[which].shift();
      res.setHeader("Content-Type", "application/json");
      if (fail) { res.statusCode = fail.status; res.end(JSON.stringify(fail.body ?? { message: "mock failure", error: { message: "mock failure", code: 999 } })); return; }
      this.n++;
      res.end(JSON.stringify(which === "resend" ? { id: `re_mock_${this.n}` } : { messages: [{ id: `wamid.MOCK${this.n}` }] }));
    });
  });
  start() { return new Promise<void>((r) => this.server.listen(MOCK_PORT, "127.0.0.1", r)); }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
  of(which: "resend" | "meta") { return this.requests.filter((r) => r.path.startsWith(which === "resend" ? "/resend" : "/meta")); }
  clear() { this.requests = []; this.failures = { resend: [], meta: [] }; }
}

export function signResend(body: string, id = "msg_test_1", ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", Buffer.from(RESEND_SECRET_B64, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}
export const signWhatsApp = (body: string) => "sha256=" + createHmac("sha256", WA_APP_SECRET).update(body).digest("hex");

export class Stack {
  mock = new MockProviders();
  proc: ChildProcess | null = null;
  log = "";
  dbUrlOwner = `${PG}/${DB}`;

  async start(extraEnv: Record<string, string> = {}) {
    const admin = new PgClient({ connectionString: `${PG}/postgres` });
    await admin.connect();
    await admin.query(`drop database if exists ${DB} with (force)`);
    await admin.query(`create database ${DB}`);
    await admin.end();
    const dbEnv = { MIGRATION_DATABASE_URL: this.dbUrlOwner, APP_DB_PASSWORD: "grainspan_app_dev", NODE_ENV: "development" as const };
    execFileSync("npx", ["tsx", "scripts/migrate.ts"], { env: { ...process.env, ...dbEnv }, stdio: "pipe" });
    execFileSync("npx", ["tsx", "scripts/seed.ts"], { env: { ...process.env, ...dbEnv }, stdio: "pipe" });
    await this.mock.start();
    this.proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
      env: {
        ...process.env, NODE_ENV: "production",
        DATABASE_URL: `postgres://grainspan_app:grainspan_app_dev@127.0.0.1:54329/${DB}`, APP_URL: BASE, APP_TIMEZONE: "Asia/Kolkata", NEXT_PUBLIC_APP_TIMEZONE: "Asia/Kolkata",
        SESSION_SECRET: "e2e-session-secret-e2e-session-secret-000000", CRON_SECRET: "cron-test-secret", COOKIE_SECURE: "false",
        RUN_SCHEDULER: "true", SCHEDULER_INTERVAL_MS: "400", AUCTION_MIN_LEAD_SECONDS: "2", SHOW_DEMO_BANNER: "true",
        RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Grainspan <procurement@test.grainspan.example>", RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}/resend`, RESEND_WEBHOOK_SECRET: "whsec_" + RESEND_SECRET_B64,
        WHATSAPP_ACCESS_TOKEN: "wa_test_token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_API_BASE: `http://127.0.0.1:${MOCK_PORT}/meta`,
        WHATSAPP_APP_SECRET: WA_APP_SECRET, WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d) => (this.log += d));
    this.proc.stderr!.on("data", (d) => (this.log += d));
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("server did not start:\n" + this.log.slice(-2000));
  }

  async stop() {
    this.proc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGKILL");
    await this.mock.stop().catch(() => undefined);
  }
  async sql<R = any>(text: string, params: unknown[] = []): Promise<R[]> {
    const c = new PgClient({ connectionString: this.dbUrlOwner }); await c.connect();
    try { return (await c.query(text, params)).rows as R[]; } finally { await c.end(); }
  }
}
