import { q, q1, withSystem } from "./db";
import { enqueueForVendors } from "./notify/enqueue";
import { processNotificationQueue } from "./notify/dispatcher";
import { closeAuction, openAuction } from "./services/auction-lifecycle";
import { enqueueAwardNotifications } from "./services/allocations";

let lastHousekeeping = 0;

/**
 * One idempotent pass over everything that depends on the passage of time. Safe to run concurrently from several instances
 * (every step takes row locks with SKIP LOCKED) and safe to run late: bid validity never depends on this having run
 * because place_bid() checks the server clock itself.
 */
export async function tick() {
  const out = { quotationsOpened: 0, quotationsClosed: 0, reminders: 0, auctionsOpened: 0, auctionsClosed: 0, closingReminders: 0, awardsReconciled: 0, notifications: null as any };

  // 1. published → quotation_open when the window opens
  out.quotationsOpened = await withSystem(async (db) => {
    const r = await db.query("update rfqs set status='quotation_open' where status='published' and (quotation_open_at is null or quotation_open_at <= now())");
    return r.rowCount ?? 0;
  });

  // 2. quotation_open → qualification at the deadline
  out.quotationsClosed = await withSystem(async (db) => {
    const r = await db.query("update rfqs set status='qualification', status_reason='Quotation deadline passed' where status='quotation_open' and quotation_deadline <= now()");
    return r.rowCount ?? 0;
  });

  // 3. quotation deadline reminders (24 h and 2 h) to invited vendors without a submitted quotation
  for (const [label, hours] of [["24h", 24], ["2h", 2]] as const) {
    out.reminders += await withSystem(async (db) => {
      // A reminder window that had already begun when the RFQ was published is skipped: the invitation itself carries the deadline.
      const due = await q<any>(db,
        `select id from rfqs where status='quotation_open' and quotation_deadline > now() and quotation_deadline <= now() + ($1::text || ' hours')::interval
            and published_at <= quotation_deadline - ($1::text || ' hours')::interval`, [String(hours)]);
      let n = 0;
      for (const r of due) {
        const vendors = await q<{ vendor_id: string }>(db,
          `select i.vendor_id from rfq_invitations i left join vendor_offers o on o.rfq_id=i.rfq_id and o.vendor_id=i.vendor_id
            where i.rfq_id=$1 and i.status<>'declined' and coalesce(o.status::text,'none') <> 'submitted'`, [r.id]);
        n += await enqueueForVendors(db, { kind: "quotation_reminder", rfqId: r.id, vendorIds: vendors.map((v) => v.vendor_id), suffix: label, perVendor: () => ({ hours_left: String(hours) }) });
      }
      return n;
    });
  }

  // 4. open auctions whose start time has passed
  const toOpen = await withSystem((db) => q<{ id: string }>(db, "select id from auctions where status='scheduled' and start_at <= clock_timestamp() order by start_at"));
  for (const a of toOpen) if (await withSystem((db) => openAuction(db, a.id))) out.auctionsOpened++;

  // 5. closing reminder (once per scheduled/extended end) when ≤ 5 minutes remain
  out.closingReminders = await withSystem(async (db) => {
    const due = await q<any>(db, "select id, rfq_id from auctions where status='live' and not closing_reminder_sent and end_at > clock_timestamp() and end_at <= clock_timestamp() + interval '5 minutes' for update skip locked");
    let n = 0;
    for (const a of due) {
      const vendors = await q<{ vendor_id: string }>(db, "select vendor_id from vendor_offers where rfq_id=$1 and status='submitted' and qualification_status='qualified'", [a.rfq_id]);
      const suffix = String((await q1<{ c: number }>(db, "select extension_count c from auctions where id=$1", [a.id]))!.c);
      n += await enqueueForVendors(db, { kind: "auction_closing_reminder", rfqId: a.rfq_id, vendorIds: vendors.map((v) => v.vendor_id), suffix });
      await db.query("update auctions set closing_reminder_sent=true where id=$1", [a.id]);
    }
    return n;
  });

  // 6. close auctions whose (possibly extended) end time has passed
  const toClose = await withSystem((db) => q<{ id: string }>(db, "select id from auctions where status='live' and end_at <= clock_timestamp() order by end_at"));
  for (const a of toClose) if (await withSystem((db) => closeAuction(db, a.id, "scheduled_end", null))) out.auctionsClosed++;

  // 7. reconcile award notifications (publication happens in the approver's transaction; the outbox rows are written here if that second step was missed)
  const pubs = await withSystem((db) => q<{ rfq_id: string }>(db, "select rfq_id from award_approvals where status='published' and published_at > now() - interval '3 days'"));
  for (const p of pubs) out.awardsReconciled += await enqueueAwardNotifications(p.rfq_id);

  // 8. deliver / retry notifications
  out.notifications = await processNotificationQueue();

  // 9. housekeeping (hourly): purge long-dead sessions and reset tokens
  if (Date.now() - lastHousekeeping > 3_600_000) {
    lastHousekeeping = Date.now();
    await withSystem(async (db) => {
      await db.query("delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'");
      await db.query("delete from password_resets where expires_at < now() - interval '7 days'");
    });
  }
  return out;
}

const g = globalThis as unknown as { __gnplSched?: NodeJS.Timeout; __gnplTicking?: boolean };

export function startScheduler(intervalMs = 2000) {
  if (g.__gnplSched) return;
  g.__gnplSched = setInterval(async () => {
    if (g.__gnplTicking) return;
    g.__gnplTicking = true;
    try { await tick(); } catch (e: any) { console.error("[scheduler] tick failed:", e?.message ?? e); } finally { g.__gnplTicking = false; }
  }, intervalMs);
  console.log(`[scheduler] started (every ${intervalMs} ms)`);
}
