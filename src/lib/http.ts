import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { DomainError, type Role } from "./db";
import { rateLimit } from "./rate-limit";
import { SESSION_COOKIE, resolveToken, type SessionUser } from "./auth/session";

export const STAFF: Role[] = ["admin", "procurement_manager", "approver"];
export const EDITORS: Role[] = ["admin", "procurement_manager"];

export function clientIp(req: NextRequest): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf ? xf.split(",")[0].trim() : req.headers.get("x-real-ip")) || "unknown";
}

/** CSRF defence in depth (cookies are also SameSite=Lax): state-changing requests must come from our own origin. */
function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) throw new DomainError("BAD_ORIGIN", "Missing Origin header.", 403);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const allowed = new Set<string>();
  if (host) { allowed.add(`https://${host}`); allowed.add(`http://${host}`); }
  if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin);
  if (!allowed.has(origin)) throw new DomainError("BAD_ORIGIN", "Cross-origin request blocked.", 403);
}

export interface Ctx<P = Record<string, string>> {
  req: NextRequest;
  user: SessionUser;
  ip: string;
  params: P;
  requestId: string;
}

interface Opts {
  roles?: Role[];                    // omit = any authenticated user
  public?: boolean;                  // no authentication required
  limit?: { name: string; max: number; windowSec: number; perIp?: boolean };
  allowPasswordChange?: boolean;     // allow users flagged must_change_password
}

type Handler<P> = (ctx: Ctx<P>) => Promise<Response | object | void>;

export function api<P = Record<string, string>>(opts: Opts, handler: Handler<P>) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const ip = clientIp(req);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);
      let user: SessionUser | null = null;
      if (!opts.public) {
        user = await resolveToken(req.cookies.get(SESSION_COOKIE)?.value);
        if (!user) throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
        if (opts.roles && !opts.roles.includes(user.role)) throw new DomainError("FORBIDDEN", "You do not have permission to perform this action.", 403);
        if (user.mustChangePassword && !opts.allowPasswordChange) throw new DomainError("PASSWORD_CHANGE_REQUIRED", "You must change your password first.", 403);
      }
      if (opts.limit) {
        const key = `${opts.limit.name}:${opts.limit.perIp || !user ? ip : user.id}`;
        const rl = rateLimit(key, opts.limit.max, opts.limit.windowSec * 1000);
        if (!rl.ok) {
          return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec), "Cache-Control": "no-store" } });
        }
      }
      const out = await handler({ req, user: user as SessionUser, ip, params: await routeCtx.params, requestId });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}

export function errorResponse(e: unknown, requestId: string): Response {
  const h = { "Cache-Control": "no-store" };
  if (e instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const i of e.issues) fields[i.path.join(".") || "_"] ??= i.message;
    return NextResponse.json({ error: { code: "VALIDATION", message: "Please correct the highlighted fields.", fields } }, { status: 400, headers: h });
  }
  if (e instanceof DomainError) {
    return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status, headers: h });
  }
  console.error(`[api ${requestId}]`, e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong. Reference: " + requestId } }, { status: 500, headers: h });
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) throw new DomainError("BAD_CONTENT_TYPE", "Expected application/json.", 415);
  let body: unknown;
  try { body = await req.json(); } catch { throw new DomainError("BAD_JSON", "Request body is not valid JSON.", 400); }
  return schema.parse(body);
}

export function uid(v: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new DomainError("NOT_FOUND", "Not found.", 404);
  return v;
}
