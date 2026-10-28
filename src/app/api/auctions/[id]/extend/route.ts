import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { extendSchema } from "@/lib/validation";
import { extendAuction } from "@/lib/services/auctions";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const b = await parseBody(req, extendSchema);
  return extendAuction(user, uid(params.id), b.minutes, b.reason);
});
