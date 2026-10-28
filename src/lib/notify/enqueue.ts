import { q, q1, type Db } from "../db";
import type { NotifKind, NotifPayload } from "./templates";

/**
 * Writes outbox rows (one per vendor per channel) inside the caller's transaction, so a notification exists if and only if the
 * business event committed. Delivery happens later in the dispatcher. `suffix` distinguishes repeatable sends (reminders, resends).
 */
export async function enqueueForVendors(db: Db, opts: {
  kind: NotifKind; rfqId: string; vendorIds: string[]; suffix?: string;
  perVendor?: (vendorId: string) => Partial<NotifPayload> | null;     // null => skip this vendor
}): Promise<number> {
  if (!opts.vendorIds.length) return 0;
  const rfq = await q1<any>(db, "select id, rfq_number, material_name, required_qty_mt, quotation_deadline, auction_start_at, auction_end_at, delivery_location from rfqs where id = $1", [opts.rfqId]);
  if (!rfq) return 0;
  const vendors = await q<any>(db,
    "select id, legal_name, contact_email, whatsapp_number, email_notifications, whatsapp_notifications from vendors where id = any($1)", [opts.vendorIds]);
  let n = 0;
  for (const v of vendors) {
    const extra = opts.perVendor ? opts.perVendor(v.id) : {};
    if (extra === null) continue;
    const payload: NotifPayload = {
      vendor_name: v.legal_name, rfq_id: rfq.id, rfq_number: rfq.rfq_number, material: rfq.material_name,
      required_qty_mt: String(rfq.required_qty_mt), quotation_deadline: rfq.quotation_deadline?.toISOString(),
      auction_start: rfq.auction_start_at?.toISOString(), auction_end: rfq.auction_end_at?.toISOString(),
      delivery_location: rfq.delivery_location, ...extra,
    };
    for (const channel of ["email", "whatsapp"] as const) {
      const recipient = channel === "email" ? v.contact_email : v.whatsapp_number;
      const optedIn = channel === "email" ? v.email_notifications : v.whatsapp_notifications;
      let status = "pending", err: string | null = null;
      if (!optedIn) { status = "skipped"; err = "Vendor has opted out of this channel"; }
      else if (!recipient) { status = "skipped"; err = channel === "email" ? "No e-mail address on file" : "No WhatsApp number on file"; }
      const r = await db.query(
        `insert into notifications(kind, channel, rfq_id, vendor_id, recipient, payload, status, last_error, provider, dedupe_key, next_attempt_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (dedupe_key) do nothing`,
        [opts.kind, channel, opts.rfqId, v.id, recipient, JSON.stringify(payload), status, err,
         channel === "email" ? "resend" : "whatsapp_cloud", `${opts.kind}:${opts.rfqId}:${v.id}:${channel}${opts.suffix ? ":" + opts.suffix : ""}`,
         status === "pending" ? new Date() : null]);
      n += r.rowCount ?? 0;
    }
  }
  return n;
}
