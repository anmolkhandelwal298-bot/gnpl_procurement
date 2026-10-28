import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { vendorStatusSchema } from "@/lib/validation";
import { setVendorStatus } from "@/lib/services/vendors";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const b = await parseBody(req, vendorStatusSchema);
  await setVendorStatus(user, uid(params.id), b.status, b.reason);
  return { ok: true };
});
