import { createHash } from "node:crypto";
import { DomainError, q, q1, translateDbError, withUser, type Db } from "../db";
import type { SessionUser } from "../auth/session";
import type { OfferInput } from "../validation";

export const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOCS_PER_OFFER = 12;

// ------------------------------------------------------------------ reads (RLS ensures a vendor only ever sees their own)
export async function listVendorRfqs(userId: string) {
  return withUser(userId, (db) => q<any>(db,
    `select r.id, r.rfq_number, r.material_name, r.grade, r.required_qty_mt, r.status, r.quotation_deadline, r.auction_start_at, r.auction_end_at, r.is_demo,
            i.status as invitation_status, o.status as offer_status, o.qualification_status
       from rfqs r join rfq_invitations i on i.rfq_id = r.id left join vendor_offers o on o.rfq_id = r.id and o.vendor_id = i.vendor_id
      order by r.created_at desc`));
}

export async function getVendorRfq(db: Db, rfqId: string) {
  // The explicit column list is the vendor-facing contract: nothing internal (created_by, status_reason, other invitees) is selected.
  const rfq = await q1<any>(db,
    `select id, rfq_number, material_name, grade, required_qty_mt, min_gcv_arb, max_moisture_pct, max_ash_pct, origin, other_specs, delivery_location,
            delivery_basis, delivery_schedule, payment_terms, quotation_open_at, quotation_deadline, auction_start_at, auction_end_at, min_decrement,
            ext_enabled, ext_trigger_seconds, ext_duration_seconds, ext_max_count, coa_required, doc_requirements, additional_terms, compliance_mode,
            status, is_demo from rfqs where id=$1`, [rfqId]);
  if (!rfq) return null;
  const invitation = await q1<any>(db, "select id, status, viewed_at from rfq_invitations where rfq_id=$1", [rfqId]);
  const offer = await q1<any>(db,
    `select id, origin, gcv_arb, moisture_pct, ash_pct, other_params, qty_offered_mt, initial_for_price, lead_time_days, remarks, status, is_compliant, compliance_issues,
            qualification_status, qualification_remarks, revision_allowed, submitted_at, version from vendor_offers where rfq_id=$1`, [rfqId]);
  const documents = offer ? await q<any>(db,
    "select id, doc_type, filename, mime_type, size_bytes, sha256, created_at from offer_documents where offer_id=$1 and removed_at is null order by created_at", [offer.id]) : [];
  const editable = !!offer ? (rfq.status === "quotation_open" && new Date(rfq.quotation_deadline) > new Date()) || (rfq.status === "qualification" && offer.revision_allowed)
                           : rfq.status === "quotation_open" && new Date(rfq.quotation_deadline) > new Date();
  return { rfq, invitation, offer, documents, editable };
}

export async function markViewed(userId: string, rfqId: string) {
  await withUser(userId, (db) => db.query("update rfq_invitations set status='viewed', viewed_at=now() where rfq_id=$1 and status='invited'", [rfqId]));
}

export async function declineInvitation(user: SessionUser, rfqId: string, reason: string | null) {
  try {
    await withUser(user.id, async (db) => {
      const r = await db.query("update rfq_invitations set status='declined', declined_at=now(), decline_reason=$2 where rfq_id=$1 and status<>'declined'", [rfqId, reason]);
      if (!r.rowCount) throw new DomainError("NOT_FOUND", "Invitation not found.", 404);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

// ------------------------------------------------------------------ write
async function ensureOffer(user: SessionUser, rfqId: string): Promise<string> {
  return withUser(user.id, async (db) => {
    const inv = await q1<any>(db, "select status from rfq_invitations where rfq_id=$1", [rfqId]);
    if (!inv) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
    if (inv.status === "declined") throw new DomainError("DECLINED", "You declined this invitation.", 409);
    const ex = await q1<{ id: string }>(db, "select id from vendor_offers where rfq_id=$1", [rfqId]);
    if (ex) return ex.id;
    const r = await q1<{ id: string }>(db, "insert into vendor_offers(rfq_id, vendor_id) values ($1,$2) returning id", [rfqId, user.vendorId]);
    return r!.id;
  });
}

/** Saves the quotation. `submit=true` additionally submits it (server-side completeness + compliance checks run in the DB trigger). */
export async function saveOffer(user: SessionUser, rfqId: string, input: OfferInput) {
  try {
    const offerId = await ensureOffer(user, rfqId);
    await withUser(user.id, async (db) => {
      const cur = await q1<any>(db, "select status from vendor_offers where id=$1 for update", [offerId]);
      const nextStatus = input.submit ? "submitted" : cur.status === "submitted" ? "submitted" : "draft";
      await db.query(
        `update vendor_offers set origin=$2, gcv_arb=$3, moisture_pct=$4, ash_pct=$5, other_params=$6, qty_offered_mt=$7, initial_for_price=$8,
           lead_time_days=$9, remarks=$10, status=$11 where id=$1`,
        [offerId, input.origin, input.gcvArb, input.moisturePct, input.ashPct, JSON.stringify(input.otherParams), input.qtyOfferedMt, input.initialForPrice,
         input.leadTimeDays, input.remarks, nextStatus]);
    });
    return offerId;
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function withdrawOffer(user: SessionUser, rfqId: string) {
  try {
    await withUser(user.id, async (db) => {
      const r = await db.query("update vendor_offers set status='withdrawn' where rfq_id=$1 and status='submitted'", [rfqId]);
      if (!r.rowCount) throw new DomainError("INVALID_STATE", "There is no submitted quotation to withdraw.", 409);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

// ------------------------------------------------------------------ documents
function detectType(b: Buffer, filename: string): { mime: string; ext: string } | null {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    if (ext === "xlsx") return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext };
    if (ext === "docx") return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext };
  }
  return null;
}
const safeName = (n: string) => n.replace(/[\\/]/g, "_").replace(/[^\p{L}\p{N}._ ()\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 150) || "document";

export async function uploadDocument(user: SessionUser, rfqId: string, docType: "coa" | "supporting", filename: string, bytes: Buffer) {
  if (bytes.length === 0) throw new DomainError("EMPTY_FILE", "The file is empty.", 400);
  if (bytes.length > MAX_DOC_BYTES) throw new DomainError("FILE_TOO_LARGE", "Files may be at most 10 MB.", 413);
  const type = detectType(bytes, filename);
  if (!type) throw new DomainError("UNSUPPORTED_FILE", "Only PDF, PNG, JPEG, XLSX and DOCX files are accepted (content is verified, not just the extension).", 415);
  const offerId = await ensureOffer(user, rfqId);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const base = safeName(filename).replace(/\.[^.]*$/, "");
  const name = `${base}.${type.ext}`;
  try {
    return await withUser(user.id, async (db) => {
      const n = await q1<{ c: number }>(db, "select count(*)::int c from offer_documents where offer_id=$1 and removed_at is null", [offerId]);
      if (n!.c >= MAX_DOCS_PER_OFFER) throw new DomainError("TOO_MANY_FILES", `At most ${MAX_DOCS_PER_OFFER} documents per quotation.`, 409);
      const d = await q1<any>(db,
        `insert into offer_documents(offer_id, rfq_id, vendor_id, doc_type, filename, mime_type, size_bytes, sha256, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, doc_type, filename, mime_type, size_bytes, created_at`,
        [offerId, rfqId, user.vendorId, docType, name, type.mime, bytes.length, sha, user.id]);
      await db.query("insert into document_blobs(document_id, content) values ($1,$2)", [d.id, bytes]);
      return d;
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function removeDocument(user: SessionUser, docId: string) {
  try {
    await withUser(user.id, async (db) => {
      const r = await db.query("update offer_documents set removed_at=now(), removed_by=$2 where id=$1 and removed_at is null", [docId, user.id]);
      if (!r.rowCount) throw new DomainError("NOT_FOUND", "Document not found.", 404);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

/** RLS decides who can read: the owning vendor, or any staff role. */
export async function readDocument(user: SessionUser, docId: string, ip: string) {
  return withUser(user.id, async (db) => {
    const d = await q1<any>(db,
      "select d.id, d.filename, d.mime_type, d.rfq_id, d.vendor_id, b.content from offer_documents d join document_blobs b on b.document_id = d.id where d.id=$1", [docId]);
    if (!d) return null;
    if (user.role !== "vendor") {
      await db.query("select write_audit('document.download','document',$1,$2,$3,$4,null,null,null,$5)", [d.id, d.rfq_id, d.vendor_id, `Downloaded ${d.filename}`, ip]);
    }
    return d as { id: string; filename: string; mime_type: string; content: Buffer };
  });
}
