import { api, parseBody, STAFF, EDITORS, uid } from "@/lib/http";
import { rfqSchema } from "@/lib/validation";
import { updateRfq } from "@/lib/services/rfqs";
import { withUser } from "@/lib/db";
import { getRfq, getInvitationsWithOffers } from "@/lib/services/rfqs";

export const GET = api<{ id: string }>({ roles: STAFF }, async ({ user, params }) => {
  return withUser(user.id, async (db) => ({ rfq: await getRfq(db, uid(params.id)), vendors: await getInvitationsWithOffers(db, uid(params.id)) }));
});
export const PUT = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  await updateRfq(user, uid(params.id), await parseBody(req, rfqSchema));
  return { ok: true };
});
