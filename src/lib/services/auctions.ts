import { DomainError, q, q1, translateDbError, withUser, type Db } from "../db";
import type { SessionUser } from "../auth/session";
import { closeAuction, lockAuction, notifyAuction } from "./auction-lifecycle";
import { MIN_LEAD_MS } from "./rfqs";

// ------------------------------------------------------------------ bidding (vendor)
export interface BidResult {
  ok: boolean; duplicate?: boolean; code?: string; message?: string; rank?: number; extended?: boolean; end_at?: string; server_time?: string;
  bid?: { id: string; seq: number; amount: string; previous_amount: string; accepted_at: string };
}

export async function placeBid(user: SessionUser, auctionId: string, amount: string, idempotencyKey: string, ip: string): Promise<BidResult> {
  try {
    return await withUser(user.id, async (db) => (await q1<{ r: BidResult }>(db, "select place_bid($1,$2,$3,$4) as r", [auctionId, amount, idempotencyKey, ip]))!.r);
  } catch (e) { translateDbError(e); }
}

// ------------------------------------------------------------------ vendor view (own data only, via SECURITY DEFINER functions)
export async function getVendorAuctionView(db: Db, rfqId: string) {
  const state = (await q1<{ s: any }>(db, "select vendor_auction_state($1) as s", [rfqId]))?.s ?? null;
  if (!state) return null;
  const history = (await q1<{ h: any[] }>(db, "select vendor_bid_history($1) as h", [state.auction_id]))?.h ?? [];
  return { ...state, history };
}

// ------------------------------------------------------------------ admin view
export async function getAdminAuctionView(db: Db, rfqId: string) {
  const auction = await q1<any>(db,
    "select * from auctions where rfq_id=$1 order by (status <> 'cancelled') desc, created_at desc limit 1", [rfqId]);
  const serverTime = (await q1<{ t: Date }>(db, "select clock_timestamp() as t"))!.t;
  if (!auction) return { auction: null, standings: [], events: [], serverTime };
  const standings = await q<any>(db,
    `select s.rank, s.vendor_id, v.vendor_code, v.legal_name, s.initial_price, s.current_price, s.price_at, s.bid_count, s.last_seq,
            o.qty_offered_mt, o.gcv_arb, o.moisture_pct, o.ash_pct, o.origin,
            (s.initial_price - s.current_price) as reduction,
            round(((s.initial_price - s.current_price) / nullif(s.initial_price, 0)) * 100, 2) as reduction_pct
       from admin_standings($1) s join vendors v on v.id = s.vendor_id join vendor_offers o on o.id = s.offer_id
      order by s.rank`, [rfqId]);
  const events = await q<any>(db,
    `select e.id, e.event_type, e.created_at, e.payload, v.vendor_code, v.legal_name, p.full_name as user_name
       from auction_events e left join vendors v on v.id = e.vendor_id left join profiles p on p.id = e.user_id
      where e.rfq_id = $1 order by e.id desc limit 150`, [rfqId]);
  return { auction, standings, events, serverTime };
}

export async function getBidHistory(db: Db, rfqId: string) {
  return q<any>(db,
    `select b.seq, b.accepted_at, v.vendor_code, v.legal_name, b.amount, b.previous_amount, (b.previous_amount - b.amount) as reduction, b.client_ip, a.id as auction_id
       from bids b join vendors v on v.id = b.vendor_id join auctions a on a.id = b.auction_id
      where b.rfq_id = $1 order by b.seq`, [rfqId]);
}

// ------------------------------------------------------------------ comparison matrix (admin only)
export async function getComparisonMatrix(db: Db, rfqId: string) {
  return q<any>(db,
    `with st as (select * from admin_standings($1))
     select st.rank, v.id as vendor_id, v.vendor_code, v.legal_name, o.id as offer_id, o.origin, o.gcv_arb, o.moisture_pct, o.ash_pct,
            o.qty_offered_mt, o.initial_for_price, st.current_price as latest_price, st.bid_count, st.price_at,
            (o.initial_for_price - st.current_price) as reduction,
            round(((o.initial_for_price - st.current_price) / nullif(o.initial_for_price, 0)) * 100, 2) as reduction_pct,
            o.is_compliant, o.qualification_status, o.qualification_remarks, o.status as offer_status, i.status as invitation_status,
            coalesce(a.allocated_qty_mt, 0) as allocated_qty_mt,
            round(coalesce(a.allocated_qty_mt, 0) * coalesce(st.current_price, o.initial_for_price, 0), 2) as award_value,
            case when o.id is null then 'No quotation'
                 when i.status = 'declined' then 'Declined'
                 when o.status <> 'submitted' then 'Quotation ' || o.status::text
                 when o.qualification_status <> 'qualified' then 'Not ranked (' || o.qualification_status::text || ')'
                 when st.bid_count > 0 then 'Bid in auction'
                 else 'Qualified – no bids' end as participation
       from rfq_invitations i
       join vendors v on v.id = i.vendor_id
       left join vendor_offers o on o.rfq_id = i.rfq_id and o.vendor_id = i.vendor_id
       left join st on st.vendor_id = v.id
       left join allocations a on a.rfq_id = i.rfq_id and a.vendor_id = v.id
      where i.rfq_id = $1
      order by st.rank nulls last, v.legal_name`, [rfqId]);
}

// ------------------------------------------------------------------ admin controls
export async function extendAuction(user: SessionUser, auctionId: string, minutes: number, reason: string) {
  try {
    return await withUser(user.id, async (db) => {
      const a = await lockAuction(db, auctionId);
      if (!a) throw new DomainError("NOT_FOUND", "Auction not found.", 404);
      if (!["scheduled", "live"].includes(a.status)) throw new DomainError("INVALID_STATE", `A ${a.status} auction cannot be extended.`, 409);
      const r = await q1<any>(db, "update auctions set end_at = end_at + ($2 || ' minutes')::interval, closing_reminder_sent=false where id=$1 returning end_at", [auctionId, String(minutes)]);
      await db.query("update rfqs set auction_end_at=$2 where id=$1", [a.rfq_id, r.end_at]);
      await db.query("insert into auction_events(auction_id, rfq_id, event_type, user_id, payload) values ($1,$2,'admin_extended',$3,$4)",
        [auctionId, a.rfq_id, user.id, JSON.stringify({ minutes, reason, previous_end_at: a.end_at, new_end_at: r.end_at })]);
      await notifyAuction(db, auctionId, a.rfq_id, "status");
      return { endAt: r.end_at as Date };
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function closeAuctionNow(user: SessionUser, auctionId: string, reason: string) {
  try {
    return await withUser(user.id, async (db) => {
      const done = await closeAuction(db, auctionId, "manual", user.id, reason);
      if (!done) throw new DomainError("INVALID_STATE", "Only a live auction can be closed.", 409);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function rescheduleAuction(user: SessionUser, auctionId: string, startAt: Date, endAt: Date, reason: string) {
  try {
    return await withUser(user.id, async (db) => {
      const a = await lockAuction(db, auctionId);
      if (!a) throw new DomainError("NOT_FOUND", "Auction not found.", 404);
      if (a.status !== "scheduled") throw new DomainError("INVALID_STATE", "Only a scheduled auction can be rescheduled.", 409);
      if (startAt.getTime() < Date.now() + MIN_LEAD_MS) throw new DomainError("VALIDATION", "The new start must be at least a minute from now.", 400);
      if (endAt <= startAt) throw new DomainError("VALIDATION", "The auction must end after it starts.", 400);
      await db.query("update auctions set start_at=$2, end_at=$3, scheduled_end_at=$3, closing_reminder_sent=false where id=$1", [auctionId, startAt, endAt]);
      await db.query("update rfqs set auction_start_at=$2, auction_end_at=$3 where id=$1", [a.rfq_id, startAt, endAt]);
      await db.query("insert into auction_events(auction_id, rfq_id, event_type, user_id, payload) values ($1,$2,'auction_rescheduled',$3,$4)",
        [auctionId, a.rfq_id, user.id, JSON.stringify({ reason, previous: { start_at: a.start_at, end_at: a.end_at }, new: { start_at: startAt, end_at: endAt } })]);
      await notifyAuction(db, auctionId, a.rfq_id, "status");
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}
