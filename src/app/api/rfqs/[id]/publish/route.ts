import { api, EDITORS, uid } from "@/lib/http";
import { publishRfq } from "@/lib/services/rfqs";
import { processNotificationQueue } from "@/lib/notify/dispatcher";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ user, params }) => {
  const r = await publishRfq(user, uid(params.id));
  void processNotificationQueue().catch(() => undefined);      // start delivery immediately; the scheduler retries on failure
  return r;
});
