import { api, uid } from "@/lib/http";
import { DomainError, q1, withUser } from "@/lib/db";
import { getVendorRfq } from "@/lib/services/offers";

export const GET = api<{ id: string }>({ roles: ["vendor"] }, async ({ user, params }) => {
  const r = await withUser(user.id, async (db) => {
    const d = await getVendorRfq(db, uid(params.id));
    if (!d) return null;
    const award = (await q1<{ r: any }>(db, "select vendor_award_result($1) r", [uid(params.id)]))?.r ?? null;
    return { ...d, award };
  });
  if (!r) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
  return r;
});
