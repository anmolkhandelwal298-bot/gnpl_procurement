import { DomainError, q, q1, translateDbError, withUser, type Db } from "../db";
import { enqueueForVendors } from "../notify/enqueue";
import { parseLocalInput } from "../time";
import type { RfqInput } from "../validation";
import type { SessionUser } from "../auth/session";

const toTs = (s: string | null) => (s ? parseLocalInput(s) : null);
/** Minimum lead between "now" and a future deadline / auction start. Default 60 s; lowered only for automated tests. */
export const MIN_LEAD_MS = Number(process.env.AUCTION_MIN_LEAD_SECONDS ?? 60) * 1000;

function rfqColumns(i: RfqInput) {
  return [i.materialName, i.grade, i.requiredQtyMt, i.minGcvArb, i.maxMoisturePct, i.maxAshPct, i.origin, i.otherSpecs, i.deliveryLocation,
    i.deliveryBasis, i.deliverySchedule, i.paymentTerms, toTs(i.quotationOpenAt), toTs(i.quotationDeadline), toTs(i.auctionStartAt), toTs(i.auctionEndAt),
    i.minDecrement, i.extEnabled, i.extTriggerSeconds, i.extDurationSeconds, i.extMaxCount, i.coaRequired, i.docRequirements, i.additionalTerms, i.complianceMode];
}
const INSERT_COLS = `material_name, grade, required_qty_mt, min_gcv_arb, max_moisture_pct, max_ash_pct, origin, other_specs, delivery_location,
  delivery_basis, delivery_schedule, payment_terms, quotation_open_at, quotation_deadline, auction_start_at, auction_end_at, min_decrement, ext_enabled,
  ext_trigger_seconds, ext_duration_seconds, ext_max_count, coa_required, doc_requirements, additional_terms, compliance_mode`;

function validateSchedule(r: { quotation_open_at: Date | null; quotation_deadline: Date | null; auction_start_at: Date | null; auction_end_at: Date | null }, requireFuture: boolean) {
  const errs: Record<string, string> = {};
  if (!r.quotation_deadline) errs.quotationDeadline = "Quotation deadline is required to publish";
  if (!r.auction_start_at) errs.auctionStartAt = "Auction start is required to publish";
  if (!r.auction_end_at) errs.auctionEndAt = "Auction end is required to publish";
  if (Object.keys(errs).length) throw new DomainError("VALIDATION", "Complete the schedule before publishing.", 400, { fields: errs });
  const now = Date.now();
  if (requireFuture && r.quotation_deadline!.getTime() <= now + MIN_LEAD_MS) errs.quotationDeadline = "Quotation deadline must be in the future";
  if (r.quotation_open_at && r.quotation_open_at >= r.quotation_deadline!) errs.quotationOpenAt = "Quotation window must open before the deadline";
  if (r.auction_start_at! < r.quotation_deadline!) errs.auctionStartAt = "Auction cannot start before the quotation deadline";
  if (r.auction_end_at! <= r.auction_start_at!) errs.auctionEndAt = "Auction end must be after its start";
  if (Object.keys(errs).length) throw new DomainError("VALIDATION", "Please correct the schedule.", 400, { fields: errs });
}

export async function createRfq(user: SessionUser, input: RfqInput) {
  try {
    return await withUser(user.id, async (db) => {
      const r = await q1<{ id: string }>(db,
        `insert into rfqs(${INSERT_COLS}, created_by) values (${Array.from({ length: 25 }, (_, i) => "$" + (i + 1)).join(",")}, $26) returning id`,
        [...rfqColumns(input), user.id]);
      if (input.invitedVendorIds.length) await addInvitations(db, user, r!.id, input.invitedVendorIds);
      return r!.id;
    });
  } catch (e) { translateDbError(e); }
}

export async function updateRfq(user: SessionUser, id: string, input: RfqInput) {
  try {
    return await withUser(user.id, async (db) => {
      const cur = await q1<any>(db, "select status from rfqs where id=$1 for update", [id]);
      if (!cur) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      if (cur.status === "draft") {
        const cols = INSERT_COLS.split(",").map((c) => c.trim());
        await db.query(`update rfqs set ${cols.map((c, i) => `${c}=$${i + 1}`).join(", ")} where id=$26`, [...rfqColumns(input), id]);
        // sync invitations while still a draft
        const existing = (await q<{ vendor_id: string }>(db, "select vendor_id from rfq_invitations where rfq_id=$1", [id])).map((r) => r.vendor_id);
        const toAdd = input.invitedVendorIds.filter((v) => !existing.includes(v));
        const toRemove = existing.filter((v) => !input.invitedVendorIds.includes(v));
        if (toRemove.length) await db.query("delete from rfq_invitations where rfq_id=$1 and vendor_id = any($2)", [id, toRemove]);
        if (toAdd.length) await addInvitations(db, user, id, toAdd);
      } else if (["published", "quotation_open", "qualification", "scheduled"].includes(cur.status)) {
        // After publication specifications are frozen (DB-enforced). Only schedule/extension settings and informational text may change.
        const cur2 = await q1<any>(db, "select quotation_deadline, auction_start_at, auction_end_at, status from rfqs where id=$1", [id]);
        const deadline = ["published", "quotation_open"].includes(cur.status) ? toTs(input.quotationDeadline) ?? cur2.quotation_deadline : cur2.quotation_deadline;
        const start = ["published", "quotation_open", "qualification"].includes(cur.status) ? toTs(input.auctionStartAt) ?? cur2.auction_start_at : cur2.auction_start_at;
        const end = ["published", "quotation_open", "qualification"].includes(cur.status) ? toTs(input.auctionEndAt) ?? cur2.auction_end_at : cur2.auction_end_at;
        validateSchedule({ quotation_open_at: null, quotation_deadline: deadline, auction_start_at: start, auction_end_at: end }, false);
        await db.query(
          `update rfqs set quotation_deadline=$2, auction_start_at=$3, auction_end_at=$4, ext_enabled=$5, ext_trigger_seconds=$6, ext_duration_seconds=$7,
             ext_max_count=$8, doc_requirements=$9, additional_terms=$10 where id=$1`,
          [id, deadline, start, end, input.extEnabled, input.extTriggerSeconds, input.extDurationSeconds, input.extMaxCount, input.docRequirements, input.additionalTerms]);
      } else {
        throw new DomainError("INVALID_STATE", `A ${cur.status} RFQ can no longer be edited.`, 409);
      }
      return id;
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function addInvitations(db: Db, user: SessionUser, rfqId: string, vendorIds: string[]) {
  for (const vendorId of vendorIds) {
    await db.query("insert into rfq_invitations(rfq_id, vendor_id, invited_by) values ($1,$2,$3) on conflict (rfq_id, vendor_id) do nothing", [rfqId, vendorId, user.id]);
  }
  const rfq = await q1<{ status: string }>(db, "select status from rfqs where id=$1", [rfqId]);
  if (rfq && rfq.status !== "draft") {
    await enqueueForVendors(db, { kind: "rfq_invitation", rfqId, vendorIds });
  }
}

export async function inviteVendors(user: SessionUser, rfqId: string, vendorIds: string[]) {
  try {
    return await withUser(user.id, async (db) => {
      await addInvitations(db, user, rfqId, vendorIds);
    });
  } catch (e) { translateDbError(e); }
}

export async function publishRfq(user: SessionUser, id: string) {
  try {
    return await withUser(user.id, async (db) => {
      const r = await q1<any>(db, "select * from rfqs where id=$1 for update", [id]);
      if (!r) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      if (r.status !== "draft") throw new DomainError("INVALID_STATE", `Only a draft RFQ can be published (this one is ${r.status}).`, 409);
      validateSchedule(r, true);
      const inv = await q<{ vendor_id: string }>(db, "select vendor_id from rfq_invitations where rfq_id=$1", [id]);
      if (!inv.length) throw new DomainError("VALIDATION", "Invite at least one approved vendor before publishing.", 400, { fields: { invitedVendorIds: "Select at least one vendor" } });
      await db.query("update rfqs set status='published' where id=$1", [id]);
      if (!r.quotation_open_at || r.quotation_open_at <= new Date()) await db.query("update rfqs set status='quotation_open' where id=$1", [id]);
      const queued = await enqueueForVendors(db, { kind: "rfq_invitation", rfqId: id, vendorIds: inv.map((v) => v.vendor_id) });
      return { invited: inv.length, notificationsQueued: queued };
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function closeQuotationsEarly(user: SessionUser, id: string, reason: string) {
  try {
    return await withUser(user.id, async (db) => {
      const r = await q1<any>(db, "select status from rfqs where id=$1 for update", [id]);
      if (!r) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      await db.query("update rfqs set status='qualification', status_reason=$2, quotation_deadline = least(quotation_deadline, now()) where id=$1", [id, reason]);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function qualifyOffer(user: SessionUser, offerId: string, status: "pending" | "qualified" | "disqualified", remarks: string | null | undefined) {
  try {
    return await withUser(user.id, async (db) => {
      const o = await q1<any>(db, "select o.id, o.is_compliant, o.status, o.rfq_id from vendor_offers o where o.id=$1 for update", [offerId]);
      if (!o) throw new DomainError("NOT_FOUND", "Quotation not found.", 404);
      if (status === "disqualified" && !remarks?.trim()) throw new DomainError("VALIDATION", "Please record the reason for disqualification.", 400, { fields: { remarks: "Reason required" } });
      if (status === "qualified" && o.is_compliant === false && !remarks?.trim()) {
        throw new DomainError("VALIDATION", "This quotation has technical deviations. Record why it is accepted.", 400, { fields: { remarks: "Justification required to qualify a non-compliant quotation" } });
      }
      await db.query("update vendor_offers set qualification_status=$2, qualification_remarks=$3, revision_allowed=false where id=$1", [offerId, status, remarks?.trim() || null]);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function grantRevision(user: SessionUser, offerId: string, allowed: boolean) {
  try {
    return await withUser(user.id, async (db) => {
      await db.query("update vendor_offers set revision_allowed=$2 where id=$1", [offerId, allowed]);
    });
  } catch (e) { translateDbError(e); }
}

export async function scheduleAuction(user: SessionUser, rfqId: string, startAt: Date, endAt: Date) {
  try {
    return await withUser(user.id, async (db) => {
      const r = await q1<any>(db, "select * from rfqs where id=$1 for update", [rfqId]);
      if (!r) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      if (r.status !== "qualification") throw new DomainError("INVALID_STATE", `An auction can only be scheduled from the qualification stage (this RFQ is ${r.status}).`, 409);
      if (startAt.getTime() < Date.now() + MIN_LEAD_MS) throw new DomainError("VALIDATION", "The auction must start at least a minute from now.", 400, { fields: { startAt: "Choose a future start time" } });
      if (endAt <= startAt) throw new DomainError("VALIDATION", "The auction must end after it starts.", 400, { fields: { endAt: "End must be after start" } });
      const offers = await q<any>(db, "select qualification_status, status from vendor_offers where rfq_id=$1 and status='submitted'", [rfqId]);
      if (offers.some((o) => o.qualification_status === "pending")) throw new DomainError("QUALIFICATION_INCOMPLETE", "Every submitted quotation must be marked qualified or disqualified before scheduling.", 409);
      const qualified = offers.filter((o) => o.qualification_status === "qualified").length;
      if (qualified < 1) throw new DomainError("QUALIFICATION_INCOMPLETE", "At least one qualified vendor is needed to run an auction.", 409);
      await db.query("update rfqs set auction_start_at=$2, auction_end_at=$3, quotation_deadline = least(quotation_deadline, now()) where id=$1", [rfqId, startAt, endAt]);
      await db.query(
        `insert into auctions(rfq_id, start_at, end_at, scheduled_end_at, min_decrement, ext_enabled, ext_trigger_seconds, ext_duration_seconds, ext_max_count, created_by)
         values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)`,
        [rfqId, startAt, endAt, r.min_decrement, r.ext_enabled, r.ext_trigger_seconds, r.ext_duration_seconds, r.ext_max_count, user.id]);
      await db.query("update rfqs set status='scheduled' where id=$1", [rfqId]);
      const a = await q1<{ id: string }>(db, "select id from auctions where rfq_id=$1 and status<>'cancelled'", [rfqId]);
      await db.query("insert into auction_events(auction_id, rfq_id, event_type, user_id, payload) values ($1,$2,'auction_scheduled',$3,$4)",
        [a!.id, rfqId, user.id, JSON.stringify({ start_at: startAt, end_at: endAt, qualified_vendors: qualified })]);
      return a!.id;
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

/** scheduled|live → qualification. The (cancelled) auction and all its bids are preserved for the record. */
export async function reopenQualification(user: SessionUser, rfqId: string, reason: string) {
  try {
    return await withUser(user.id, async (db) => {
      const r = await q1<any>(db, "select status from rfqs where id=$1 for update", [rfqId]);
      if (!r) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      if (!["scheduled", "live"].includes(r.status)) throw new DomainError("INVALID_STATE", "Qualification can only be reopened before the auction closes.", 409);
      if (r.status === "live" && user.role !== "admin") throw new DomainError("FORBIDDEN", "Only an administrator can reopen qualification once an auction is live.", 403);
      const a = await q1<any>(db, "select id from auctions where rfq_id=$1 and status in ('scheduled','live') for update", [rfqId]);
      if (a) {
        await db.query("update auctions set status='cancelled', closed_at=now(), closed_by=$2, close_reason=$3 where id=$1", [a.id, user.id, "qualification reopened: " + reason]);
        await db.query("insert into auction_events(auction_id, rfq_id, event_type, user_id, payload) values ($1,$2,'auction_cancelled',$3,$4)",
          [a.id, rfqId, user.id, JSON.stringify({ reason, cause: "qualification_reopened" })]);
        await db.query("select pg_notify('auction_events', $1)", [JSON.stringify({ auction_id: a.id, rfq_id: rfqId, kind: "status" })]);
      }
      await db.query("update rfqs set status='qualification', status_reason=$2 where id=$1", [rfqId, reason]);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function cancelRfq(user: SessionUser, rfqId: string, reason: string) {
  try {
    return await withUser(user.id, async (db) => {
      const r = await q1<any>(db, "select status from rfqs where id=$1 for update", [rfqId]);
      if (!r) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
      if (["awarded", "cancelled"].includes(r.status)) throw new DomainError("INVALID_STATE", `A ${r.status} RFQ cannot be cancelled.`, 409);
      if (r.status === "live" && user.role !== "admin") throw new DomainError("FORBIDDEN", "Only an administrator can cancel an RFQ while its auction is live.", 403);
      const a = await q1<any>(db, "select id from auctions where rfq_id=$1 and status in ('scheduled','live') for update", [rfqId]);
      if (a) {
        await db.query("update auctions set status='cancelled', closed_at=now(), closed_by=$2, close_reason=$3 where id=$1", [a.id, user.id, "rfq cancelled: " + reason]);
        await db.query("insert into auction_events(auction_id, rfq_id, event_type, user_id, payload) values ($1,$2,'auction_cancelled',$3,$4)",
          [a.id, rfqId, user.id, JSON.stringify({ reason, cause: "rfq_cancelled" })]);
        await db.query("select pg_notify('auction_events', $1)", [JSON.stringify({ auction_id: a.id, rfq_id: rfqId, kind: "status" })]);
      }
      await db.query("update rfqs set status='cancelled', status_reason=$2 where id=$1", [rfqId, reason]);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

// ------------------------------------------------------------------ reads
export async function listRfqs(userId: string, opts: { status?: string; search?: string } = {}) {
  return withUser(userId, (db) => q<any>(db,
    `select r.id, r.rfq_number, r.material_name, r.grade, r.required_qty_mt, r.status, r.quotation_deadline, r.auction_start_at, r.auction_end_at, r.is_demo, r.created_at,
       (select count(*) from rfq_invitations i where i.rfq_id=r.id)::int as invited,
       (select count(*) from vendor_offers o where o.rfq_id=r.id and o.status='submitted')::int as submitted,
       (select count(*) from vendor_offers o where o.rfq_id=r.id and o.qualification_status='qualified')::int as qualified
     from rfqs r
     where ($1::text is null or r.status::text = $1)
       and ($2::text is null or r.rfq_number ilike '%'||$2||'%' or r.material_name ilike '%'||$2||'%')
     order by r.created_at desc limit 200`, [opts.status || null, opts.search || null]));
}

export async function getRfq(db: Db, id: string) {
  return q1<any>(db, "select * from rfqs where id=$1", [id]);
}

export async function getInvitationsWithOffers(db: Db, rfqId: string) {
  return q<any>(db,
    `select i.id as invitation_id, i.status as invitation_status, i.invited_at, i.viewed_at, i.declined_at, i.decline_reason,
            v.id as vendor_id, v.vendor_code, v.legal_name, v.contact_email, v.whatsapp_number, v.is_demo,
            o.id as offer_id, o.status as offer_status, o.origin, o.gcv_arb, o.moisture_pct, o.ash_pct, o.qty_offered_mt, o.initial_for_price,
            o.lead_time_days, o.remarks, o.is_compliant, o.compliance_issues, o.qualification_status, o.qualification_remarks, o.revision_allowed,
            o.submitted_at, o.other_params,
            (select count(*) from offer_documents d where d.offer_id=o.id and d.removed_at is null)::int as doc_count
       from rfq_invitations i join vendors v on v.id=i.vendor_id
       left join vendor_offers o on o.rfq_id=i.rfq_id and o.vendor_id=i.vendor_id
      where i.rfq_id=$1 order by v.legal_name`, [rfqId]);
}
