import { DomainError, q, q1, translateDbError, withSystem, withUser, type Db } from "../db";
import type { SessionUser } from "../auth/session";
import { enqueueForVendors } from "../notify/enqueue";

export async function getWorksheet(db: Db, rfqId: string) {
  const rfq = await q1<any>(db, "select id, rfq_number, material_name, required_qty_mt, status, min_decrement from rfqs where id=$1", [rfqId]);
  if (!rfq) return null;
  const cycles = await q<any>(db,
    `select a.*, sp.full_name as submitted_by_name, dp.full_name as decided_by_name, pp.full_name as published_by_name
       from award_approvals a left join profiles sp on sp.id=a.submitted_by left join profiles dp on dp.id=a.decided_by left join profiles pp on pp.id=a.published_by
      where a.rfq_id=$1 order by a.cycle_no desc`, [rfqId]);
  const lines = await q<any>(db,
    `select v.id as vendor_id, v.vendor_code, v.legal_name, o.id as offer_id, o.qty_offered_mt, o.gcv_arb, o.moisture_pct, o.ash_pct, o.origin,
            o.qualification_status, o.is_compliant, s.rank, s.initial_price, s.current_price, s.bid_count,
            coalesce(a.allocated_qty_mt, 0) as allocated_qty_mt, a.remarks,
            round(coalesce(a.allocated_qty_mt, 0) * s.current_price, 2) as value
       from admin_standings($1) s
       join vendors v on v.id = s.vendor_id join vendor_offers o on o.id = s.offer_id
       left join allocations a on a.rfq_id = $1 and a.vendor_id = s.vendor_id
      order by s.rank`, [rfqId]);
  const totalAllocated = lines.reduce((t, l) => t + Number(l.allocated_qty_mt), 0);
  const totalValue = lines.reduce((t, l) => t + Number(l.value ?? 0), 0);
  return { rfq, cycles, current: cycles[0] ?? null, lines, totalAllocated, totalValue, remaining: Number(rfq.required_qty_mt) - totalAllocated };
}

export interface AllocLine { vendorId: string; qty: string; remarks?: string | null }

export async function saveAllocations(user: SessionUser, rfqId: string, lines: AllocLine[]) {
  try {
    return await withUser(user.id, async (db) => {
      const rfq = await q1<any>(db, "select id, status, required_qty_mt from rfqs where id=$1 for update", [rfqId]);
      if (!rfq) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      if (rfq.status !== "closed") throw new DomainError("INVALID_STATE", "Quantities can be allocated only after the auction has closed and before the award is published.", 409);
      const latest = await q1<any>(db, "select id, status from award_approvals where rfq_id=$1 order by cycle_no desc limit 1", [rfqId]);
      if (latest && ["submitted", "approved", "published"].includes(latest.status)) {
        throw new DomainError("ALLOCATION_LOCKED", `The allocation is ${latest.status} and cannot be edited.`, 409);
      }
      const offers = await q<any>(db,
        "select vendor_id, id as offer_id, qty_offered_mt, qualification_status, status from vendor_offers where rfq_id=$1", [rfqId]);
      const byVendor = new Map(offers.map((o) => [o.vendor_id, o]));
      const fields: Record<string, string> = {};
      let total = 0;
      for (const l of lines) {
        const o = byVendor.get(l.vendorId);
        const qty = Number(l.qty);
        if (!o) { fields[l.vendorId] = "This vendor has no quotation on this RFQ."; continue; }
        if (qty < 0) fields[l.vendorId] = "Quantity cannot be negative.";
        else if (qty > 0 && (o.qualification_status !== "qualified" || o.status !== "submitted")) fields[l.vendorId] = "Quantity can only be allocated to a qualified vendor.";
        else if (qty > Number(o.qty_offered_mt)) fields[l.vendorId] = `Exceeds the offered quantity of ${Number(o.qty_offered_mt).toLocaleString("en-IN")} MT.`;
        total += qty;
      }
      if (total > Number(rfq.required_qty_mt)) fields["_total"] = `Total ${total.toLocaleString("en-IN")} MT exceeds the RFQ requirement of ${Number(rfq.required_qty_mt).toLocaleString("en-IN")} MT.`;
      if (Object.keys(fields).length) throw new DomainError("VALIDATION", "The allocation is not valid.", 422, { fields });
      if (!latest || latest.status === "rejected") await db.query("insert into award_approvals(rfq_id) values ($1)", [rfqId]);
      for (const l of lines) {
        const o = byVendor.get(l.vendorId)!;
        await db.query(
          `insert into allocations(rfq_id, vendor_id, offer_id, allocated_qty_mt, remarks) values ($1,$2,$3,$4,$5)
           on conflict (rfq_id, vendor_id) do update set allocated_qty_mt = excluded.allocated_qty_mt, remarks = excluded.remarks`,
          [rfqId, l.vendorId, o.offer_id, l.qty, l.remarks?.trim() || null]);
      }
      return { total };
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

async function activeCycle(db: Db, rfqId: string, status: string) {
  const c = await q1<any>(db, "select id, status from award_approvals where rfq_id=$1 and status=$2", [rfqId, status]);
  return c;
}

export async function submitAward(user: SessionUser, rfqId: string, remarks?: string | null) {
  try {
    return await withUser(user.id, async (db) => {
      const c = await activeCycle(db, rfqId, "draft");
      if (!c) throw new DomainError("INVALID_STATE", "There is no draft allocation to submit. Save an allocation first.", 409);
      await db.query("update award_approvals set status='submitted', submit_remarks=$2 where id=$1", [c.id, remarks?.trim() || null]);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function decideAward(user: SessionUser, rfqId: string, decision: "approve" | "reject", remarks?: string | null) {
  try {
    return await withUser(user.id, async (db) => {
      const c = await activeCycle(db, rfqId, "submitted");
      if (!c) throw new DomainError("INVALID_STATE", "There is no award awaiting approval.", 409);
      await db.query("update award_approvals set status=$2, decision_remarks=$3 where id=$1", [c.id, decision === "approve" ? "approved" : "rejected", remarks?.trim() || null]);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function publishAward(user: SessionUser, rfqId: string) {
  try {
    await withUser(user.id, async (db) => {
      const c = await activeCycle(db, rfqId, "approved");
      if (!c) throw new DomainError("INVALID_STATE", "Only an approved award can be published.", 409);
      await db.query("update award_approvals set status='published' where id=$1", [c.id]);   // trigger flips the RFQ to 'awarded'
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
  return enqueueAwardNotifications(rfqId);
}

/** Idempotent (dedupe keys): safe to call again from the scheduler's reconciliation pass. */
export async function enqueueAwardNotifications(rfqId: string): Promise<number> {
  return withSystem(async (db) => {
    const aw = await q1<any>(db, "select snapshot from award_approvals where rfq_id=$1 and status='published'", [rfqId]);
    if (!aw) return 0;
    const lines = new Map<string, any>((aw.snapshot as any[]).map((l) => [l.vendor_id, l]));
    const participants = (await q<{ vendor_id: string }>(db, "select vendor_id from vendor_offers where rfq_id=$1 and status='submitted' and qualification_status='qualified'", [rfqId])).map((r) => r.vendor_id);
    const awarded = participants.filter((v) => lines.has(v));
    const notAwarded = participants.filter((v) => !lines.has(v));
    let n = 0;
    n += await enqueueForVendors(db, {
      kind: "award", rfqId, vendorIds: awarded,
      perVendor: (v) => { const l = lines.get(v); return { allocated_qty_mt: String(l.allocated_qty_mt), final_price: String(l.final_price), value: String(l.value) }; },
    });
    n += await enqueueForVendors(db, { kind: "non_award", rfqId, vendorIds: notAwarded });
    return n;
  });
}
