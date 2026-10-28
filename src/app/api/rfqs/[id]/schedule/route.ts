import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { scheduleAuctionSchema } from "@/lib/validation";
import { scheduleAuction } from "@/lib/services/rfqs";
import { parseLocalInput } from "@/lib/time";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const b = await parseBody(req, scheduleAuctionSchema);
  return { auctionId: await scheduleAuction(user, uid(params.id), parseLocalInput(b.startAt), parseLocalInput(b.endAt)) };
});
