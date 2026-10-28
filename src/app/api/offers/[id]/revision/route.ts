import { z } from "zod";
import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { grantRevision } from "@/lib/services/rfqs";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ allowed: z.boolean() }));
  await grantRevision(user, uid(params.id), b.allowed);
  return { ok: true };
});
