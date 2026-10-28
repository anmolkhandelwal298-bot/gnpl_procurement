import { q, q1, type Db } from "../db";
import { enqueueForVendors } from "../notify/enqueue";

/** Lock order everywhere in the app: RFQ row first, then its auction row (prevents deadlocks between admin actions and the scheduler). */
export async function lockAuction(db: Db, auctionId: string) {
  const ref = await q1<{ rfq_id: string }>(db, "select rfq_id from auctions where id=$1", [auctionId]);
  if (!ref) return null;
  await db.query("select 1 from rfqs where id=$1 for update", [ref.rfq_id]);
  return q1<any>(db, "select * from auctions where id=$1 for update", [auctionId]);
}

export const notifyAuction = (db: Db, auctionId: string, rfqId: string, kind: string) =>
  db.query("select pg_notify('auction_events', $1)", [JSON.stringify({ auction_id: auctionId, rfq_id: rfqId, kind })]);

const qualifiedVendorIds = async (db: Db, rfqId: string) =>
  (await q<{ vendor_id: string }>(db, "select vendor_id from vendor_offers where rfq_id=$1 and status='submitted' and qualification_status='qualified'", [rfqId])).map((r) => r.vendor_id);

/** scheduled → live. Caller must hold the auction row lock. Idempotent. */
export async function openAuction(db: Db, auctionId: string, actorLabel = "scheduler"): Promise<boolean> {
  const a = await lockAuction(db, auctionId);
  if (!a || a.status !== "scheduled") return false;
  await db.query("update auctions set status='live', opened_at=clock_timestamp() where id=$1", [auctionId]);
  await db.query("update rfqs set status='live' where id=$1 and status='scheduled'", [a.rfq_id]);
  await db.query("insert into auction_events(auction_id, rfq_id, event_type, payload) values ($1,$2,'auction_opened',$3)", [auctionId, a.rfq_id, JSON.stringify({ by: actorLabel })]);
  await enqueueForVendors(db, { kind: "auction_open", rfqId: a.rfq_id, vendorIds: await qualifiedVendorIds(db, a.rfq_id) });
  await notifyAuction(db, auctionId, a.rfq_id, "status");
  return true;
}

/** live → closed. `userId` null = scheduler. Sets end_at to the actual close instant so the record is unambiguous. */
export async function closeAuction(db: Db, auctionId: string, reason: "scheduled_end" | "manual", userId: string | null, note?: string): Promise<boolean> {
  const a = await lockAuction(db, auctionId);
  if (!a || a.status !== "live") return false;
  await db.query(
    `update auctions set status='closed', closed_at=clock_timestamp(), closed_by=$2, close_reason=$3,
       end_at = least(end_at, clock_timestamp()) where id=$1`, [auctionId, userId, note ? `${reason}: ${note}` : reason]);
  await db.query("update rfqs set status='closed' where id=$1 and status='live'", [a.rfq_id]);
  await db.query("insert into auction_events(auction_id, rfq_id, event_type, user_id, payload) values ($1,$2,'auction_closed',$3,$4)",
    [auctionId, a.rfq_id, userId, JSON.stringify({ reason, note: note ?? null })]);
  await enqueueForVendors(db, { kind: "auction_closed", rfqId: a.rfq_id, vendorIds: await qualifiedVendorIds(db, a.rfq_id) });
  await notifyAuction(db, auctionId, a.rfq_id, "status");
  return true;
}
