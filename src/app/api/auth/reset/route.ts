import { z } from "zod";
import { api, parseBody } from "@/lib/http";
import { DomainError, q1, withAuth } from "@/lib/db";
import { hashToken, revokeAllSessions } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { passwordSchema } from "@/lib/validation";

export const POST = api({ public: true, limit: { name: "reset", max: 10, windowSec: 900, perIp: true } }, async ({ req }) => {
  const { token, password } = await parseBody(req, z.object({ token: z.string().min(20).max(100), password: passwordSchema }));
  const hash = await hashPassword(password);
  const userId = await withAuth(async (db) => {
    const r = await q1<{ id: string; user_id: string }>(db,
      "update password_resets set used_at=now() where token_hash=$1 and used_at is null and expires_at > now() returning id, user_id", [hashToken(token)]);
    if (!r) return null;
    await db.query("update user_credentials set password_hash=$2, must_change_password=false, failed_login_count=0, locked_until=null, password_changed_at=now() where user_id=$1", [r.user_id, hash]);
    await db.query("select write_audit('auth.password_reset','user',$1,null,null,'Password reset via e-mail link',null,null,null,null)", [r.user_id]);
    return r.user_id;
  });
  if (!userId) throw new DomainError("INVALID_TOKEN", "This reset link is invalid or has expired.", 400);
  await revokeAllSessions(userId);
  return { ok: true };
});
