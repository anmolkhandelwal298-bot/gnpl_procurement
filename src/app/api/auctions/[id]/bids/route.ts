import { NextResponse } from "next/server";
import { api, parseBody, uid } from "@/lib/http";
import { bidSchema } from "@/lib/validation";
import { placeBid } from "@/lib/services/auctions";

// Vendors only. Every rule (identity, eligibility, clock, decrement, idempotency) is enforced inside the database function.
export const POST = api<{ id: string }>({ roles: ["vendor"], limit: { name: "bid", max: 30, windowSec: 60 } }, async ({ req, user, params, ip }) => {
  const b = await parseBody(req, bidSchema);
  const r = await placeBid(user, uid(params.id), b.amount, b.idempotencyKey, ip);
  if (!r.ok) return NextResponse.json({ error: { code: r.code, message: r.message } }, { status: r.code === "NOT_ELIGIBLE" ? 403 : 422, headers: { "Cache-Control": "no-store" } });
  return r;
});
