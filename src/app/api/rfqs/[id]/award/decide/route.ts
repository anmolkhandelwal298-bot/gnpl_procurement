import { api, parseBody, uid } from "@/lib/http";
import { decisionSchema } from "@/lib/validation";
import { decideAward } from "@/lib/services/allocations";

export const POST = api<{ id: string }>({ roles: ["approver", "admin"] }, async ({ req, user, params }) => {
  const b = await parseBody(req, decisionSchema);
  await decideAward(user, uid(params.id), b.decision, b.remarks);
  return { ok: true };
});
