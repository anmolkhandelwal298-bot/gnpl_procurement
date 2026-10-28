import { api, parseBody } from "@/lib/http";
import { changePasswordSchema } from "@/lib/validation";
import { DomainError, q1, withAuth } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";

export const POST = api({ allowPasswordChange: true, limit: { name: "chpw", max: 10, windowSec: 600 } }, async ({ req, user }) => {
  const { currentPassword, newPassword } = await parseBody(req, changePasswordSchema);
  if (currentPassword === newPassword) throw new DomainError("VALIDATION", "Choose a password different from the current one.", 400, { fields: { newPassword: "Must differ from current password" } });
  const row = await withAuth((db) => q1<{ password_hash: string }>(db, "select password_hash from user_credentials where user_id=$1", [user.id]));
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw new DomainError("INVALID_CREDENTIALS", "Current password is incorrect.", 400, { fields: { currentPassword: "Incorrect" } });
  const hash = await hashPassword(newPassword);
  await withAuth((db) => db.query("update user_credentials set password_hash=$2, must_change_password=false, password_changed_at=now() where user_id=$1", [user.id, hash]));
  await revokeAllSessions(user.id, user.sessionId);
  return { ok: true, redirect: user.role === "vendor" ? "/vendor" : "/admin" };
});
