import { NextResponse } from "next/server";
import { api } from "@/lib/http";
import { logout, SESSION_COOKIE } from "@/lib/auth/session";

export const POST = api({ allowPasswordChange: true }, async ({ user, ip }) => {
  await logout(user, ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
});
