import { Client } from "pg";
import { withUser, withSystem, q, q1, pool, type Db } from "@/lib/db";

let _owner: Client | null = null;
/** Superuser-ish connection, used ONLY to arrange fixtures / simulate tampering. Never used for assertions about access. */
export async function owner(): Promise<Client> {
  if (!_owner) {
    _owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await _owner.connect();
  }
  return _owner;
}
export async function ownerQ<R = any>(sql: string, params: unknown[] = []): Promise<R[]> {
  return (await (await owner()).query(sql, params)).rows as R[];
}
export async function closeAll() {
  if (_owner) { await _owner.end(); _owner = null; }
  await pool().end();
  (globalThis as any).__gnplPool = undefined;
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function mkUser(role: "admin" | "procurement_manager" | "approver", name: string = role) {
  const email = `${role}.${uniq()}@grainspan.test`;
  const [{ id }] = await ownerQ<{ id: string }>(
    "insert into profiles(email, full_name, role) values ($1,$2,$3) returning id", [email, `${name} ${uniq()}`, role]);
  await ownerQ("insert into user_credentials(user_id, password_hash) values ($1,'x')", [id]);
  return id;
}

export async function mkVendor(status: "approved" | "pending" = "approved", name = "Vendor") {
  const tag = uniq();
  const [{ id: userId }] = await ownerQ<{ id: string }>(
    "insert into profiles(email, full_name, role) values ($1,$2,'vendor') returning id", [`v.${tag}@vendor.test`, `${name} User ${tag}`]);
  await ownerQ("insert into user_credentials(user_id, password_hash) values ($1,'x')", [userId]);
  const [{ id: vendorId }] = await ownerQ<{ id: string }>(
    `insert into vendors(legal_name, contact_name, contact_email, whatsapp_number, status)
     values ($1,'Contact',$2,'+919800000000',$3) returning id`, [`${name} ${tag} Pvt Ltd`, `v.${tag}@vendor.test`, status]);
  await ownerQ("insert into vendor_users(user_id, vendor_id, is_primary) values ($1,$2,true)", [userId, vendorId]);
  return { userId, vendorId };
}

export interface RfqOverrides { coa_required?: boolean; compliance_mode?: "strict" | "review"; min_decrement?: number; max_ash_pct?: number | null;
  ext_enabled?: boolean; ext_trigger_seconds?: number; ext_duration_seconds?: number; ext_max_count?: number; required_qty_mt?: number }

export async function mkRfq(managerId: string, o: RfqOverrides = {}) {
  return withUser(managerId, async (db) => {
    const r = await q1<{ id: string }>(db,
      `insert into rfqs(material_name, grade, required_qty_mt, min_gcv_arb, max_moisture_pct, max_ash_pct, origin, delivery_location,
         quotation_deadline, auction_start_at, auction_end_at, min_decrement, coa_required, compliance_mode,
         ext_enabled, ext_trigger_seconds, ext_duration_seconds, ext_max_count, created_by)
       values ('Steam Coal','G-10',$1,4000,18,$2,'Indonesia','Plant gate, Kutch',
         now()+interval '10 minutes', now()+interval '20 minutes', now()+interval '50 minutes', $3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [o.required_qty_mt ?? 1000, o.max_ash_pct === undefined ? 12 : o.max_ash_pct, o.min_decrement ?? 10, o.coa_required ?? false,
       o.compliance_mode ?? "strict", o.ext_enabled ?? false, o.ext_trigger_seconds ?? 120, o.ext_duration_seconds ?? 120,
       o.ext_max_count ?? 5, managerId]);
    return r!.id;
  });
}

export async function openRfq(managerId: string, rfqId: string, vendorIds: string[]) {
  await withUser(managerId, async (db) => {
    await db.query("update rfqs set status='published' where id=$1", [rfqId]);
    for (const v of vendorIds) await db.query("insert into rfq_invitations(rfq_id, vendor_id, invited_by) values ($1,$2,$3)", [rfqId, v, managerId]);
    await db.query("update rfqs set status='quotation_open' where id=$1", [rfqId]);
  });
}

export interface OfferFields { origin?: string; gcv_arb?: number; moisture_pct?: number; ash_pct?: number | null; qty_offered_mt?: number;
  initial_for_price?: number; lead_time_days?: number }
export const goodOffer = (price: number, qty = 500): OfferFields => ({ origin: "Indonesia", gcv_arb: 4200, moisture_pct: 15, ash_pct: 8,
  qty_offered_mt: qty, initial_for_price: price, lead_time_days: 14 });

export async function saveOffer(vendorUserId: string, rfqId: string, vendorId: string, f: OfferFields, submit = true) {
  return withUser(vendorUserId, async (db) => {
    const ex = await q1<{ id: string }>(db, "select id from vendor_offers where rfq_id=$1 and vendor_id=$2", [rfqId, vendorId]);
    let id = ex?.id;
    if (!id) {
      id = (await q1<{ id: string }>(db, "insert into vendor_offers(rfq_id, vendor_id) values ($1,$2) returning id", [rfqId, vendorId]))!.id;
    }
    await db.query(
      `update vendor_offers set origin=$2, gcv_arb=$3, moisture_pct=$4, ash_pct=$5, qty_offered_mt=$6, initial_for_price=$7, lead_time_days=$8,
         status=$9 where id=$1`,
      [id, f.origin, f.gcv_arb, f.moisture_pct, f.ash_pct, f.qty_offered_mt, f.initial_for_price, f.lead_time_days, submit ? "submitted" : "draft"]);
    return id;
  });
}

export interface LiveOpts { prices?: number[]; qty?: number[]; decrement?: number; endInSec?: number; ext?: Partial<RfqOverrides>; startInSec?: number;
  /** extra invited vendors who submit a quotation but are left UNQUALIFIED (pending) */ pendingPrices?: number[] }

/** A fully-driven RFQ that ends up with a LIVE auction, built through the real guarded paths (RLS-bound roles + triggers). */
export async function liveAuction(opts: LiveOpts = {}) {
  const prices = opts.prices ?? [5000, 5100];
  const managerId = await mkUser("procurement_manager", "Manager");
  const approverId = await mkUser("approver", "Approver");
  const adminId = await mkUser("admin", "Admin");
  const vendors = [];
  const pendingPrices = opts.pendingPrices ?? [];
  const allPrices = [...prices, ...pendingPrices];
  for (let i = 0; i < allPrices.length; i++) vendors.push(await mkVendor("approved", `Vendor${String.fromCharCode(65 + i)}`));
  const rfqId = await mkRfq(managerId, { min_decrement: opts.decrement ?? 10, ...opts.ext });
  await openRfq(managerId, rfqId, vendors.map((v) => v.vendorId));
  const offerIds: string[] = [];
  for (let i = 0; i < vendors.length; i++) {
    offerIds.push(await saveOffer(vendors[i].userId, rfqId, vendors[i].vendorId, goodOffer(allPrices[i], opts.qty?.[i] ?? 500)));
  }
  await withUser(managerId, async (db) => {
    await db.query("update rfqs set status='qualification' where id=$1", [rfqId]);
    for (const id of offerIds.slice(0, prices.length)) await db.query("update vendor_offers set qualification_status='qualified' where id=$1", [id]);
    await db.query(
      `insert into auctions(rfq_id, start_at, end_at, scheduled_end_at, min_decrement, ext_enabled, ext_trigger_seconds, ext_duration_seconds, ext_max_count, created_by)
       select id, auction_start_at, auction_end_at, auction_end_at, min_decrement, ext_enabled, ext_trigger_seconds, ext_duration_seconds, ext_max_count, $2
       from rfqs where id=$1`, [rfqId, managerId]);
    await db.query("update rfqs set status='scheduled' where id=$1", [rfqId]);
  });
  const startIn = opts.startInSec ?? -3600;
  const endIn = opts.endInSec ?? 1800;
  await ownerQ(`update rfqs set quotation_deadline = now() - interval '2 hours', auction_start_at = now() + ($2 || ' seconds')::interval,
                 auction_end_at = now() + ($3 || ' seconds')::interval where id=$1`, [rfqId, String(startIn), String(endIn)]);
  const [a] = await ownerQ<{ id: string }>(
    `update auctions set start_at = now() + ($2 || ' seconds')::interval, end_at = now() + ($3 || ' seconds')::interval,
       scheduled_end_at = now() + ($3 || ' seconds')::interval where rfq_id=$1 returning id`, [rfqId, String(startIn), String(endIn)]);
  if (startIn <= 0) {
    await ownerQ("update auctions set status='live', opened_at=now() where id=$1", [a.id]);
    await ownerQ("update rfqs set status='live' where id=$1", [rfqId]);
  }
  const all = vendors.map((v, i) => ({ ...v, offerId: offerIds[i] }));
  return { rfqId, auctionId: a.id, managerId, approverId, adminId, vendors: all.slice(0, prices.length), pending: all.slice(prices.length) };
}

export const bid = (userId: string, auctionId: string, amount: number | string, key = `k-${uniq()}-${Math.random().toString(36).slice(2)}`) =>
  withUser(userId, async (db) => (await q1<{ place_bid: any }>(db, "select place_bid($1,$2,$3,$4)", [auctionId, amount, key, "127.0.0.1"]))!.place_bid);

export async function asUserTry<T>(userId: string, fn: (db: Db) => Promise<T>) {
  try { return { ok: true as const, value: await withUser(userId, fn) }; }
  catch (e: any) { return { ok: false as const, code: e.code as string | undefined, message: e.message as string }; }
}
export { withUser, withSystem, q, q1 };
