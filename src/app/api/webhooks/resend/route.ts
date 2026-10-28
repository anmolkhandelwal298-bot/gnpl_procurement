import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withSystem } from "@/lib/db";

// Resend signs webhooks with Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>" using the base64 secret after "whsec_".
function verify(req: NextRequest, body: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = req.headers.get("svix-id"), ts = req.headers.get("svix-timestamp"), sigs = req.headers.get("svix-signature");
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(" ").some((s) => {
    const [, b64] = s.split(",");
    if (!b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  if (!verify(req, body)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const evt = JSON.parse(body) as { type: string; data?: { email_id?: string; bounce?: { message?: string }; reason?: string } };
  const mid = evt.data?.email_id;
  if (!mid) return NextResponse.json({ ok: true });
  await withSystem(async (db) => {
    if (evt.type === "email.delivered") {
      await db.query("update notifications set status='delivered', delivered_at=now(), last_error=null where provider_message_id=$1", [mid]);
    } else if (["email.bounced", "email.failed", "email.complained", "email.suppressed"].includes(evt.type)) {
      const why = evt.data?.bounce?.message ?? evt.data?.reason ?? evt.type;
      await db.query("update notifications set status='failed', failed_at=now(), last_error=$2 where provider_message_id=$1 and status in ('sent','pending','delivered')", [mid, `Resend: ${why}`]);
    }
  });
  return NextResponse.json({ ok: true });
}
