import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { inviteSchema } from "@/lib/validation";
import { inviteVendors } from "@/lib/services/rfqs";
import { processNotificationQueue } from "@/lib/notify/dispatcher";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const { vendorIds } = await parseBody(req, inviteSchema);
  await inviteVendors(user, uid(params.id), vendorIds);
  void processNotificationQueue().catch(() => undefined);
  return { ok: true };
});
