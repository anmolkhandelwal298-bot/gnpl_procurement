import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { reasonSchema } from "@/lib/validation";
import { closeAuctionNow } from "@/lib/services/auctions";
import { processNotificationQueue } from "@/lib/notify/dispatcher";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  await closeAuctionNow(user, uid(params.id), (await parseBody(req, reasonSchema)).reason);
  void processNotificationQueue().catch(() => undefined);
  return { ok: true };
});
