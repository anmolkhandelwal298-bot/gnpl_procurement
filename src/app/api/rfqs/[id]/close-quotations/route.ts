import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { reasonSchema } from "@/lib/validation";
import { closeQuotationsEarly } from "@/lib/services/rfqs";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  await closeQuotationsEarly(user, uid(params.id), (await parseBody(req, reasonSchema)).reason);
  return { ok: true };
});
