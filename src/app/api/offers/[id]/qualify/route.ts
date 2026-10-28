import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { qualifySchema } from "@/lib/validation";
import { qualifyOffer } from "@/lib/services/rfqs";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const b = await parseBody(req, qualifySchema);
  await qualifyOffer(user, uid(params.id), b.status, b.remarks);
  return { ok: true };
});
