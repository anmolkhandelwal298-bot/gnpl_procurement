import { z } from "zod";
import { api, parseBody, uid } from "@/lib/http";
import { passwordSchema } from "@/lib/validation";
import { adminResetPassword } from "@/lib/services/vendors";

export const POST = api<{ id: string }>({ roles: ["admin"], limit: { name: "pw-reset", max: 10, windowSec: 60 } }, async ({ req, user, params }) => {
  await adminResetPassword(user, uid(params.id), (await parseBody(req, z.object({ password: passwordSchema }))).password);
  return { ok: true };
});
