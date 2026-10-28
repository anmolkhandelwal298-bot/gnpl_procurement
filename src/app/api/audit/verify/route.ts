import { api, STAFF } from "@/lib/http";
import { q1, withUser } from "@/lib/db";

export const GET = api({ roles: STAFF, limit: { name: "audit-verify", max: 10, windowSec: 60 } }, async ({ user }) =>
  withUser(user.id, async (db) => (await q1(db, "select * from verify_audit_chain()")) ?? { ok: false }));
