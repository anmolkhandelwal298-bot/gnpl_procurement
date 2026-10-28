import { z } from "zod";
import { api, parseBody, uid } from "@/lib/http";
import { setUserActive } from "@/lib/services/vendors";

export const POST = api<{ id: string }>({ roles: ["admin"] }, async ({ req, user, params }) => {
  await setUserActive(user, uid(params.id), (await parseBody(req, z.object({ active: z.boolean() }))).active);
  return { ok: true };
});
