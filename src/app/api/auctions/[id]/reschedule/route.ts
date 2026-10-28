import { z } from "zod";
import { api, parseBody, EDITORS, uid } from "@/lib/http";
import { scheduleAuctionSchema } from "@/lib/validation";
import { rescheduleAuction } from "@/lib/services/auctions";
import { parseLocalInput } from "@/lib/time";

export const POST = api<{ id: string }>({ roles: EDITORS }, async ({ req, user, params }) => {
  const b = await parseBody(req, scheduleAuctionSchema.extend({ reason: z.string().trim().min(5).max(1000) }));
  await rescheduleAuction(user, uid(params.id), parseLocalInput(b.startAt), parseLocalInput(b.endAt), b.reason);
  return { ok: true };
});
