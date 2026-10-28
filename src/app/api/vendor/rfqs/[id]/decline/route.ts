import { z } from "zod";
import { api, parseBody, uid } from "@/lib/http";
import { declineInvitation } from "@/lib/services/offers";

export const POST = api<{ id: string }>({ roles: ["vendor"] }, async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ reason: z.string().trim().max(500).optional().nullable() }));
  await declineInvitation(user, uid(params.id), b.reason ?? null);
  return { ok: true };
});
