import { api, uid } from "@/lib/http";
import { publishAward } from "@/lib/services/allocations";
import { processNotificationQueue } from "@/lib/notify/dispatcher";

export const POST = api<{ id: string }>({ roles: ["approver", "admin"] }, async ({ user, params }) => {
  const queued = await publishAward(user, uid(params.id));
  void processNotificationQueue().catch(() => undefined);
  return { ok: true, notificationsQueued: queued };
});
