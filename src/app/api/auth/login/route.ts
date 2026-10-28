import { NextResponse } from "next/server";
import { api, parseBody } from "@/lib/http";
import { loginSchema } from "@/lib/validation";
import { login, resolveToken, SESSION_COOKIE } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { DomainError } from "@/lib/db";

export const POST = api({ public: true, limit: { name: "login-ip", max: 20, windowSec: 60, perIp: true } }, async ({ req, ip }) => {
  const { email, password } = await parseBody(req, loginSchema);
  // second limiter per target account so a distributed attacker cannot hammer one login
  const per = rateLimit(`login-acct:${email.toLowerCase()}`, 10, 5 * 60_000);
  if (!per.ok) throw new DomainError("RATE_LIMITED", "Too many attempts for this account. Try again later.", 429);
  const r = await login(email, password, ip, req.headers.get("user-agent") ?? "");
  if (!r.ok) {
    if (r.reason === "locked") throw new DomainError("ACCOUNT_LOCKED", "This account is temporarily locked after repeated failed sign-ins. Try again in 15 minutes.", 423);
    throw new DomainError("INVALID_CREDENTIALS", "Incorrect e-mail or password.", 401);
  }
  const user = await resolveToken(r.token);
  const res = NextResponse.json({
    ok: true, role: user!.role, mustChangePassword: user!.mustChangePassword,
    redirect: user!.mustChangePassword ? "/account/password" : user!.role === "vendor" ? "/vendor" : "/admin",
  }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.COOKIE_SECURE === "true", maxAge: Number(process.env.SESSION_ABSOLUTE_HOURS ?? 12) * 3600 });
  return res;
});
