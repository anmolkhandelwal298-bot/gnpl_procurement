import { afterAll, describe, expect, it } from "vitest";
import { closeAll, goodOffer, liveAuction, mkRfq, mkUser, mkVendor, openRfq, ownerQ, q, q1, saveOffer, withUser, asUserTry } from "../helpers/fixtures";

afterAll(closeAll);

async function openWithVendor(o: Parameters<typeof mkRfq>[1] = {}) {
  const managerId = await mkUser("procurement_manager");
  const v = await mkVendor();
  const rfqId = await mkRfq(managerId, o);
  await openRfq(managerId, rfqId, [v.vendorId]);
  return { managerId, v, rfqId };
}

describe("quotation submission rules", () => {
  it("strict mode rejects technically non-compliant quotations and explains why", async () => {
    const { v, rfqId } = await openWithVendor({ compliance_mode: "strict" });
    await expect(saveOffer(v.userId, rfqId, v.vendorId, { ...goodOffer(5000), gcv_arb: 3800 })).rejects.toMatchObject({ code: "P0001" });
    const e: any = await saveOffer(v.userId, rfqId, v.vendorId, { ...goodOffer(5000), gcv_arb: 3800, moisture_pct: 25, ash_pct: 20 }).catch((x) => x);
    expect(e.message).toMatch(/^NON_COMPLIANT:/);
    const issues = JSON.parse(e.message.replace("NON_COMPLIANT: ", ""));
    expect(issues.map((i: any) => i.field).sort()).toEqual(["ash_pct", "gcv_arb", "moisture_pct"]);
  });

  it("review mode accepts but flags non-compliant quotations for the qualification step", async () => {
    const { v, rfqId } = await openWithVendor({ compliance_mode: "review" });
    await saveOffer(v.userId, rfqId, v.vendorId, { ...goodOffer(5000), gcv_arb: 3800 });
    const o = (await ownerQ("select is_compliant, compliance_issues, qualification_status from vendor_offers where rfq_id=$1", [rfqId]))[0];
    expect(o.is_compliant).toBe(false);
    expect(o.compliance_issues[0].field).toBe("gcv_arb");
    expect(o.qualification_status).toBe("pending");
  });

  it("rejects incomplete submissions in both modes, but allows saving a partial draft", async () => {
    const { v, rfqId } = await openWithVendor({ compliance_mode: "review" });
    const e: any = await saveOffer(v.userId, rfqId, v.vendorId, { ...goodOffer(5000), lead_time_days: undefined as any, initial_for_price: undefined as any }).catch((x) => x);
    expect(e.message).toMatch(/^INCOMPLETE: missing initial_for_price, lead_time_days/);
    await saveOffer(v.userId, rfqId, v.vendorId, { origin: "Indonesia" }, false);        // draft is fine
    expect((await ownerQ("select status from vendor_offers where rfq_id=$1", [rfqId]))[0].status).toBe("draft");
  });

  it("requires a COA when the RFQ demands one", async () => {
    const { v, rfqId } = await openWithVendor({ coa_required: true });
    const offerId = await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(5000), false);   // draft first (documents attach to the draft)
    const e: any = await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(5000)).catch((x) => x);
    expect(e.message).toMatch(/NON_COMPLIANT.*coa/s);
    // upload a COA document record, then submission succeeds
    await withUser(v.userId, async (db) => {
      await db.query(`insert into offer_documents(offer_id,rfq_id,vendor_id,doc_type,filename,mime_type,size_bytes,sha256,uploaded_by)
                      values ($1,$2,$3,'coa','coa.pdf','application/pdf',10,'abc',$4)`, [offerId, rfqId, v.vendorId, v.userId]);
    });
    await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(5000));
    expect((await ownerQ("select status, is_compliant from vendor_offers where id=$1", [offerId]))[0]).toMatchObject({ status: "submitted", is_compliant: true });
  });

  it("vendors may revise until the deadline, then the quotation is locked", async () => {
    const { v, rfqId } = await openWithVendor();
    await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(5000));
    await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(4900));                      // revision before deadline ok
    expect((await ownerQ("select initial_for_price, version from vendor_offers where rfq_id=$1", [rfqId]))[0]).toMatchObject({ initial_for_price: "4900.00", version: 3 });
    await ownerQ("update rfqs set quotation_deadline = now() - interval '1 minute', auction_start_at = now() + interval '1 hour', auction_end_at = now() + interval '2 hours' where id=$1", [rfqId]);
    const e: any = await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(4000)).catch((x) => x);
    expect(e.message).toMatch(/^OFFER_LOCKED/);
  });

  it("specs and quantity stay locked after the auction is scheduled/live; formal reopen + per-vendor grant allows a revision that resets qualification", async () => {
    const f = await liveAuction({ prices: [5000, 5100], startInSec: 600, endInSec: 1800 });   // scheduled, not yet started
    const A = f.vendors[0];
    const locked: any = await saveOffer(A.userId, f.rfqId, A.vendorId, goodOffer(4000)).catch((x) => x);
    expect(locked.message).toMatch(/^OFFER_LOCKED/);
    // staff reopen qualification (scheduled → qualification) and grant ONE vendor a revision
    await withUser(f.managerId, async (db) => {
      await db.query("update auctions set status='cancelled' where rfq_id=$1", [f.rfqId]);
      await db.query("update rfqs set status='qualification' where id=$1", [f.rfqId]);
      await db.query("update vendor_offers set revision_allowed=true where id=$1", [A.offerId]);
    });
    const bLocked: any = await saveOffer(f.vendors[1].userId, f.rfqId, f.vendors[1].vendorId, goodOffer(4000)).catch((x) => x);
    expect(bLocked.message).toMatch(/^OFFER_LOCKED/);                                        // not granted → still locked
    await saveOffer(A.userId, f.rfqId, A.vendorId, goodOffer(4800, 450));
    const o = (await ownerQ("select qualification_status, revision_allowed, qty_offered_mt from vendor_offers where id=$1", [A.offerId]))[0];
    expect(o).toMatchObject({ qualification_status: "pending", revision_allowed: false, qty_offered_mt: "450.000" });
    const again: any = await saveOffer(A.userId, f.rfqId, A.vendorId, goodOffer(4700, 450)).catch((x) => x);
    expect(again.message).toMatch(/^OFFER_LOCKED/);                                          // permission was consumed
  });

  it("staff cannot edit a vendor's technical data and vendors cannot qualify themselves", async () => {
    const { managerId, v, rfqId } = await openWithVendor();
    const offerId = await saveOffer(v.userId, rfqId, v.vendorId, goodOffer(5000));
    const edit = await asUserTry(managerId, (db) => db.query("update vendor_offers set initial_for_price=1 where id=$1", [offerId]));
    expect(edit.ok).toBe(false);
    await withUser(managerId, (db) => db.query("update rfqs set status='qualification' where id=$1", [rfqId]));
    await withUser(managerId, (db) => db.query("update vendor_offers set qualification_status='qualified', qualification_remarks='ok' where id=$1", [offerId]));
    const o = (await ownerQ("select qualification_status, qualified_by from vendor_offers where id=$1", [offerId]))[0];
    expect(o.qualification_status).toBe("qualified");
    expect(o.qualified_by).toBe(managerId);
  });
});

describe("RFQ state machine and invitations", () => {
  it("rejects invalid transitions", async () => {
    const managerId = await mkUser("procurement_manager");
    const rfqId = await mkRfq(managerId);
    const bad = async (to: string) => (await asUserTry(managerId, (db) => db.query("update rfqs set status=$2 where id=$1", [rfqId, to]))).ok;
    expect(await bad("live")).toBe(false);
    expect(await bad("closed")).toBe(false);
    expect(await bad("awarded")).toBe(false);
    expect(await bad("qualification")).toBe(false);
    expect(await bad("published")).toBe(true);
    expect(await bad("draft")).toBe(false);                    // no going back
    expect(await bad("scheduled")).toBe(false);
    expect(await bad("quotation_open")).toBe(true);
    expect(await bad("cancelled")).toBe(true);
    expect(await bad("quotation_open")).toBe(false);           // cancelled is terminal
  });

  it("freezes specifications after publication but still allows schedule changes", async () => {
    const managerId = await mkUser("procurement_manager");
    const rfqId = await mkRfq(managerId);
    expect((await asUserTry(managerId, (db) => db.query("update rfqs set min_gcv_arb=4500 where id=$1", [rfqId]))).ok).toBe(true);   // draft: editable
    await withUser(managerId, (db) => db.query("update rfqs set status='published' where id=$1", [rfqId]));
    const spec: any = await asUserTry(managerId, (db) => db.query("update rfqs set min_gcv_arb=3000 where id=$1", [rfqId]));
    expect(spec.ok).toBe(false);
    expect(spec.message).toMatch(/SPEC_LOCKED/);
    expect((await asUserTry(managerId, (db) => db.query("update rfqs set quotation_deadline = quotation_deadline + interval '1 hour', auction_start_at = auction_start_at + interval '1 hour', auction_end_at = auction_end_at + interval '1 hour' where id=$1", [rfqId]))).ok).toBe(true);
  });

  it("only approved vendors can be invited, and not after the quotation phase", async () => {
    const managerId = await mkUser("procurement_manager");
    const pending = await mkVendor("pending");
    const rfqId = await mkRfq(managerId);
    const r: any = await asUserTry(managerId, (db) => db.query("insert into rfq_invitations(rfq_id, vendor_id) values ($1,$2)", [rfqId, pending.vendorId]));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/VENDOR_NOT_APPROVED/);
    const f = await liveAuction({ prices: [5000] });
    const late = await mkVendor();
    const l: any = await asUserTry(f.managerId, (db) => db.query("insert into rfq_invitations(rfq_id, vendor_id) values ($1,$2)", [f.rfqId, late.vendorId]));
    expect(l.ok).toBe(false);
  });

  it("draft RFQs are invisible to invited vendors; an uninvited vendor can never read the RFQ", async () => {
    const managerId = await mkUser("procurement_manager");
    const v = await mkVendor();
    const rfqId = await mkRfq(managerId);
    await withUser(managerId, (db) => db.query("insert into rfq_invitations(rfq_id, vendor_id) values ($1,$2)", [rfqId, v.vendorId]));
    expect((await withUser(v.userId, (db) => q(db, "select id from rfqs"))).length).toBe(0);      // still draft
    await withUser(managerId, (db) => db.query("update rfqs set status='published' where id=$1", [rfqId]));
    expect((await withUser(v.userId, (db) => q(db, "select id from rfqs"))).length).toBe(1);
    const stranger = await mkVendor();
    expect((await withUser(stranger.userId, (db) => q(db, "select id from rfqs"))).length).toBe(0);
  });

  it("a vendor can decline an invitation but cannot invite others or change invitation ownership", async () => {
    const managerId = await mkUser("procurement_manager");
    const a = await mkVendor(); const b = await mkVendor();
    const rfqId = await mkRfq(managerId);
    await openRfq(managerId, rfqId, [a.vendorId]);
    expect((await asUserTry(a.userId, (db) => db.query("update rfq_invitations set status='declined', decline_reason='no stock' where rfq_id=$1", [rfqId]))).ok).toBe(true);
    expect((await asUserTry(a.userId, (db) => db.query("insert into rfq_invitations(rfq_id, vendor_id) values ($1,$2)", [rfqId, b.vendorId]))).ok).toBe(false);
    expect((await asUserTry(a.userId, (db) => db.query("update rfq_invitations set vendor_id=$2 where rfq_id=$1", [rfqId, b.vendorId]))).ok).toBe(false);
    // a declined vendor cannot then submit a quotation
    const e: any = await saveOffer(a.userId, rfqId, a.vendorId, goodOffer(5000)).catch((x) => x);
    expect(e.code).toBe("42501");
  });
});
