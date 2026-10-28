import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { reasonSchema } from "@/lib/validation";
import { reopenQualification } from "@/lib/services/rfqs";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  await reopenQualification(user, uid(params.id), (await parseBody(req, reasonSchema)).reason);
  return { ok: true };
});
