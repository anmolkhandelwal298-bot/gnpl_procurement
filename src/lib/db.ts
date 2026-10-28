import { Pool, type PoolClient, type QueryResultRow } from "pg";

export type Role = "admin" | "procurement_manager" | "approver" | "vendor" | "system";
export const STAFF_ROLES: Role[] = ["admin", "procurement_manager", "approver"];

export type Db = PoolClient;

function sslConfig() {
  const v = process.env.DATABASE_SSL;
  if (!v || v === "false") return undefined;
  return v === "no-verify" ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
}

const g = globalThis as unknown as { __gnplPool?: Pool };

/** Pool for the restricted `grainspan_app` role. Survives Next.js hot reloads via globalThis. */
export function pool(): Pool {
  if (!g.__gnplPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    g.__gnplPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(),
      max: Number(process.env.DB_POOL_MAX ?? 20),
      idleTimeoutMillis: 30_000,
      statement_timeout: 20_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: "grainspan-app",
    });
    g.__gnplPool.on("error", (e) => console.error("[pg pool]", e.message));
  }
  return g.__gnplPool;
}

type Mode = "user" | "auth" | "system";
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

async function run<T>(mode: Mode, userId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    // is_local=true -> settings vanish at COMMIT/ROLLBACK, so pooled connections never leak identity between requests.
    await client.query("select set_config('app.mode', $1, true), set_config('app.user_id', $2, true)", [mode, userId ?? ""]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Runs `fn` in one transaction with RLS evaluated as `userId` (an already-authenticated profile id). */
export const withUser = <T>(userId: string, fn: (db: Db) => Promise<T>) => run("user", userId, fn);
/** Authentication bootstrap path only (login, session lookup, registration, password reset). */
export const withAuth = <T>(fn: (db: Db) => Promise<T>) => run("auth", null, fn);
/** Background jobs (scheduler, notification dispatcher). Never reachable from a request handler's user input. */
export const withSystem = <T>(fn: (db: Db) => Promise<T>) => run("system", SYSTEM_USER_ID, fn);

export async function q<R extends QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query<R>(text, params)).rows;
}
export async function q1<R extends QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<R | null> {
  return (await db.query<R>(text, params)).rows[0] ?? null;
}

/** Maps Postgres errors raised by our triggers/functions (errcode P0001 with a CODE: prefix) to a structured error. */
export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

export function translateDbError(e: unknown): never {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (err?.code === "P0001" && err.message) {
    const m = /^([A-Z_]+):\s*(.*)$/s.exec(err.message);
    if (m) {
      let details: unknown;
      if (m[1] === "NON_COMPLIANT") { try { details = JSON.parse(m[2]); } catch { /* ignore */ } }
      throw new DomainError(m[1], m[1] === "NON_COMPLIANT" ? "The quotation does not meet the RFQ's technical requirements." : m[2], 422, details);
    }
    throw new DomainError("RULE_VIOLATION", err.message, 422);
  }
  if (err?.code === "42501") throw new DomainError("FORBIDDEN", "You do not have permission to perform this action.", 403);
  if (err?.code === "23505") throw new DomainError("DUPLICATE", "A record with the same unique value already exists.", 409, { constraint: err.constraint });
  if (err?.code === "23514") throw new DomainError("CONSTRAINT", "A value violates a data rule: " + (err.constraint ?? ""), 422);
  if (err?.code === "22P02") throw new DomainError("BAD_INPUT", "A value has an invalid format.", 400);
  throw e;
}
