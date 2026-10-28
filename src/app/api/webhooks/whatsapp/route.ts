import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withSystem } from "@/lib/db";

// GET: Meta's one-time webhook verification handshake.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (expected && sp.get("hub.mode") === "subscribe" && sp.get("hub.verify_token") === expected) {
    return new Response(sp.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

// POST: delivery receipts. Signed with X-Hub-Signature-256 = sha256=HMAC(app secret, raw body).
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secret = process.env.WHATSAPP_APP_SECRET;
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { statuses?: { id: string; status: string; errors?: { title?: string; code?: number }[] }[] } }[] }[] };
  await withSystem(async (db) => {
    for (const e of body.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
      if (s.status === "delivered" || s.status === "read") {
        await db.query("update notifications set status='delivered', delivered_at=coalesce(delivered_at, now()), last_error=null where provider_message_id=$1 and status in ('sent','pending')", [s.id]);
      } else if (s.status === "failed") {
        const err = s.errors?.[0];
        await db.query("update notifications set status='failed', failed_at=now(), last_error=$2 where provider_message_id=$1 and status in ('sent','pending','delivered')",
          [s.id, `WhatsApp delivery failed${err?.code ? ` (code ${err.code})` : ""}: ${err?.title ?? "unknown"}`]);
      }
    }
  });
  return NextResponse.json({ ok: true });
}
