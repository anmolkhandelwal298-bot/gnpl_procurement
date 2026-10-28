import { api, parseBody, STAFF, EDITORS } from "@/lib/http";
import { rfqSchema } from "@/lib/validation";
import { createRfq, listRfqs } from "@/lib/services/rfqs";

export const GET = api({ roles: STAFF }, async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  return { rfqs: await listRfqs(user.id, { status: sp.get("status") ?? undefined, search: sp.get("search") ?? undefined }) };
});
export const POST = api({ roles: EDITORS, limit: { name: "rfq-create", max: 30, windowSec: 60 } }, async ({ req, user }) => {
  const input = await parseBody(req, rfqSchema);
  return { id: await createRfq(user, input) };
});
