import { createHmac, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { DomainError, q1, withAuth, withUser, type Role } from "../db";
import { dummyHash, verifyPassword } from "./password";

export const SESSION_COOKIE = "gnpl_session";
const ABSOLUTE_HOURS = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 12);
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES ?? 60);
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  vendorId: string | null;
  vendorName: string | null;
  vendorStatus: string | null;
  mustChangePassword: boolean;
  sessionId: string;
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 characters");
  return s;
}
export const hashToken = (t: string) => createHmac("sha256", secret()).update(t).digest("hex");

export async function login(email: string, password: string, ip: string, userAgent: string) {
  const result = await withAuth(async (db) => {
    const row = await q1<{ id: string; is_active: boolean; password_hash: string; failed_login_count: number; locked_until: Date | null; locked: boolean }>(
      db,
      `select p.id, p.is_active, c.password_hash, c.failed_login_count, c.locked_until, coalesce(c.locked_until > now(), false) as locked
         from profiles p join user_credentials c on c.user_id = p.id where lower(p.email) = lower($1) and p.role <> 'system'`, [email]);
    if (!row) {
      await verifyPassword(password, await dummyHash());
      await db.query("select write_audit('auth.login_failed','user',null,null,null,'Login failed: unknown account',null,null,$1::jsonb,$2)", [JSON.stringify({ email: email.slice(0, 200) }), ip]);
      return { ok: false as const, reason: "invalid" };
    }
    if (row.locked) return { ok: false as const, reason: "locked" };
    const good = await verifyPassword(password, row.password_hash);
    if (!good || !row.is_active) {
      const n = row.failed_login_count + 1;
      await db.query("update user_credentials set failed_login_count = $2::int, locked_until = case when $2::int >= $3::int then now() + ($4::text || ' minutes')::interval end where user_id = $1",
        [row.id, n, MAX_FAILED, String(LOCK_MINUTES)]);
      await db.query("select write_audit('auth.login_failed','user',$1,null,null,$2,null,null,null,$3)", [row.id, n >= MAX_FAILED ? "Login failed: account locked" : "Login failed: bad password", ip]);
      return { ok: false as const, reason: n >= MAX_FAILED ? "locked" : "invalid" };
    }
    const token = randomBytes(32).toString("base64url");
    await db.query("update user_credentials set failed_login_count = 0, locked_until = null where user_id = $1", [row.id]);
    await db.query("update profiles set last_login_at = now() where id = $1", [row.id]);
    await db.query("insert into sessions(user_id, token_hash, expires_at, ip, user_agent) values ($1,$2, now() + ($3 || ' hours')::interval, $4, $5)",
      [row.id, hashToken(token), String(ABSOLUTE_HOURS), ip, userAgent.slice(0, 300)]);
    return { ok: true as const, userId: row.id, token };
  });
  if (result.ok) {
    await withUser(result.userId, (db) => db.query("select write_audit('auth.login','user',$1,null,null,'Signed in',null,null,null,$2)", [result.userId, ip]));
  }
  return result;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/", secure: process.env.COOKIE_SECURE === "true", maxAge: ABSOLUTE_HOURS * 3600,
  });
}
export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.COOKIE_SECURE === "true", maxAge: 0 });
}

export async function resolveToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  return withAuth(async (db) => {
    const r = await q1<any>(db,
      `select s.id as session_id, p.id, p.email, p.full_name, p.role, c.must_change_password,
              v.id as vendor_id, v.legal_name, v.status as vendor_status, (s.last_seen_at < now() - interval '60 seconds') as stale
         from sessions s join profiles p on p.id = s.user_id join user_credentials c on c.user_id = p.id
         left join vendor_users vu on vu.user_id = p.id left join vendors v on v.id = vu.vendor_id
        where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
          and s.last_seen_at > now() - ($2 || ' minutes')::interval and p.is_active`, [hashToken(token), String(IDLE_MINUTES)]);
    if (!r) return null;
    if (r.stale) await db.query("update sessions set last_seen_at = now() where id = $1", [r.session_id]);
    return {
      id: r.id, email: r.email, fullName: r.full_name, role: r.role, vendorId: r.vendor_id, vendorName: r.legal_name,
      vendorStatus: r.vendor_status, mustChangePassword: r.must_change_password, sessionId: r.session_id,
    } satisfies SessionUser;
  });
}

/** Current user for server components / actions (deduplicated per request). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return resolveToken(token);
});

export async function logout(user: SessionUser, ip: string) {
  await withAuth((db) => db.query("update sessions set revoked_at = now() where id = $1", [user.sessionId]));
  await withUser(user.id, (db) => db.query("select write_audit('auth.logout','user',$1,null,null,'Signed out',null,null,null,$2)", [user.id, ip]));
  await clearSessionCookie();
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await withAuth((db) => db.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2)", [userId, exceptSessionId ?? null]));
}

export function assertRole(user: SessionUser | null, roles: Role[]): asserts user is SessionUser {
  if (!user) throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  if (!roles.includes(user.role)) throw new DomainError("FORBIDDEN", "You do not have permission to perform this action.", 403);
}
