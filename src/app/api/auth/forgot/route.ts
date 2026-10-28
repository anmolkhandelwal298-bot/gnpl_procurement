import { randomBytes } from "node:crypto";
import { z } from "zod";
import { api, parseBody } from "@/lib/http";
import { q1, withAuth } from "@/lib/db";
import { hashToken } from "@/lib/auth/session";
import { sendEmail } from "@/lib/notify/email";
import { appUrl } from "@/lib/notify/config";

export const POST = api({ public: true, limit: { name: "forgot", max: 5, windowSec: 900, perIp: true } }, async ({ req }) => {
  const { email } = await parseBody(req, z.object({ email: z.email().max(200) }));
  const generic = { ok: true, message: "If an account exists for that address, a reset link has been sent." };
  const token = randomBytes(32).toString("base64url");
  const found = await withAuth(async (db) => {
    const p = await q1<{ id: string; full_name: string }>(db, "select id, full_name from profiles where lower(email)=lower($1) and is_active and role <> 'system'", [email]);
    if (!p) return null;
    await db.query("insert into password_resets(user_id, token_hash, expires_at) values ($1,$2, now() + interval '30 minutes')", [p.id, hashToken(token)]);
    return p;
  });
  if (found) {
    const url = `${appUrl()}/reset-password?token=${token}`;
    const text = `Hello ${found.full_name},\n\nUse the link below to set a new password for the Grainspan Procurement Portal. It is valid for 30 minutes and can be used once.\n\n${url}\n\nIf you did not request this, you can ignore this e-mail.`;
    const r = await sendEmail(email, "Reset your Grainspan portal password", `<p>${text.replace(/\n\n/g, "</p><p>").replace(url, `<a href="${url}">${url}</a>`)}</p>`, text, `pwreset-${token.slice(0, 16)}`);
    if (!r.ok) console.warn("[auth] password reset e-mail not sent:", r.error);
  }
  return generic;
});
