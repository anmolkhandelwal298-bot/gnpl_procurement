import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { submitAwardSchema } from "@/lib/validation";
import { submitAward } from "@/lib/services/allocations";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  await submitAward(user, uid(params.id), (await parseBody(req, submitAwardSchema)).remarks);
  return { ok: true };
});
