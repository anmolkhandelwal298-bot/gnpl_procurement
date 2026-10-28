import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { asUserTry, bid, closeAll, liveAuction, mkVendor, ownerQ, q, q1, withUser } from "../helpers/fixtures";

afterAll(closeAll);

const count = async (userId: string, table: string) =>
  withUser(userId, async (db) => Number((await q1(db, `select count(*)::int c from ${table}`))!.c));

describe("vendor data isolation (RLS)", () => {
  it("a vendor sees only their own rows in every vendor-visible table", async () => {
    const f = await liveAuction({ prices: [5000, 5100] });
    const other = await liveAuction({ prices: [9000] });            // a completely separate RFQ + vendor
    const [A, B] = f.vendors;

    const offers = await withUser(A.userId, (db) => q(db, "select vendor_id from vendor_offers"));
    expect(offers.map((o: any) => o.vendor_id)).toEqual([A.vendorId]);
    const vendors = await withUser(A.userId, (db) => q(db, "select id from vendors"));
    expect(vendors.map((v: any) => v.id)).toEqual([A.vendorId]);
    const invs = await withUser(A.userId, (db) => q(db, "select vendor_id from rfq_invitations"));
    expect(invs.map((i: any) => i.vendor_id)).toEqual([A.vendorId]);
    const rfqs = await withUser(A.userId, (db) => q(db, "select id from rfqs"));
    expect(rfqs.map((r: any) => r.id)).toEqual([f.rfqId]);          // never the other RFQ
    const profiles = await withUser(A.userId, (db) => q(db, "select id from profiles"));
    expect(profiles.map((p: any) => p.id)).toEqual([A.userId]);     // no other vendor's or staff identity
    const vu = await withUser(A.userId, (db) => q(db, "select user_id from vendor_users"));
    expect(vu.map((p: any) => p.user_id)).toEqual([A.userId]);
    expect(await count(other.vendors[0].userId, "vendor_offers")).toBe(1);
    expect(B.vendorId).not.toBe(A.vendorId);
  });

  it("vendors cannot read bids, auctions, events, allocations, awards, notifications, audit logs, credentials or sessions", async () => {
    const f = await liveAuction({ prices: [5000, 5100] });
    await bid(f.vendors[0].userId, f.auctionId, 4900);
    for (const t of ["bids", "auctions", "auction_events", "allocations", "award_approvals", "notifications", "audit_logs", "user_credentials", "sessions", "password_resets"]) {
      expect(await count(f.vendors[1].userId, t), `table ${t}`).toBe(0);
      expect(await count(f.vendors[0].userId, t), `table ${t} (own bidder)`).toBe(0);
    }
    expect((await ownerQ("select count(*)::int c from bids"))[0].c).toBeGreaterThan(0);   // the data exists, it is just invisible
  });

  it("with no/unknown context nothing is readable (fail-closed)", async () => {
    await liveAuction({ prices: [5000] });
    const c = await pool().connect();
    try {
      for (const t of ["profiles", "vendors", "rfqs", "vendor_offers", "bids", "auctions", "audit_logs", "user_credentials", "sessions"]) {
        expect(Number((await c.query(`select count(*)::int c from ${t}`)).rows[0].c), t).toBe(0);
      }
    } finally { c.release(); }
    // a made-up user id is also treated as 'anon'
    const ghost = await asUserTry("11111111-1111-1111-1111-111111111111", (db) => q(db, "select * from rfqs"));
    expect(ghost.ok && (ghost.value as any[]).length).toBe(0);
  });

  it("vendors cannot modify another vendor's quotation or documents, and cannot touch staff-controlled columns", async () => {
    const f = await liveAuction({ prices: [5000, 5100] });
    const [A, B] = f.vendors;
    const steal = await withUser(A.userId, async (db) => (await db.query("update vendor_offers set initial_for_price=1 where id=$1", [B.offerId])).rowCount);
    expect(steal).toBe(0);
    const selfQualify = await asUserTry(A.userId, (db) => db.query("update vendor_offers set qualification_status='qualified' where id=$1", [A.offerId]));
    expect(selfQualify.ok).toBe(false);
    const selfPromote = await asUserTry(A.userId, (db) => db.query("update profiles set role='admin' where id=$1", [A.userId]));
    expect(selfPromote.ok).toBe(false);
    const selfApprove = await asUserTry(A.userId, (db) => db.query("update vendors set status='approved', vendor_code='VND-9999' where id=$1", [A.vendorId]));
    expect(selfApprove.ok).toBe(false);
    const insertRfq = await asUserTry(A.userId, (db) => db.query(
      "insert into rfqs(material_name,required_qty_mt,min_gcv_arb,max_moisture_pct,delivery_location,min_decrement,created_by) values ('x',1,1,1,'x',1,$1)", [A.userId]));
    expect(insertRfq.ok).toBe(false);
  });

  it("vendors cannot call internal or admin functions", async () => {
    const f = await liveAuction({ prices: [5000] });
    const A = f.vendors[0];
    const standings = await asUserTry(A.userId, (db) => q(db, "select * from admin_standings($1)", [f.rfqId]));
    expect(standings.ok).toBe(false);
    const direct = await asUserTry(A.userId, (db) => q(db, "select * from compute_standings($1,$2)", [f.rfqId, f.auctionId]));
    expect(direct.ok).toBe(false);
    expect((direct as any).message).toMatch(/permission denied/);
    const forgedAudit = await asUserTry(A.userId, (db) => q(db, "select audit_append('x','x','x',null,null,null,null,null,null,null)"));
    expect(forgedAudit.ok).toBe(false);
    const chain = await asUserTry(A.userId, (db) => q(db, "select * from verify_audit_chain()"));
    expect(chain.ok).toBe(false);
  });

  it("vendor_auction_state exposes ONLY the caller's own figures (no competitor name/price/count)", async () => {
    const f = await liveAuction({ prices: [5000, 4000, 4500] });
    await bid(f.vendors[1].userId, f.auctionId, 3900);
    const s = await withUser(f.vendors[0].userId, async (db) => (await q1(db, "select vendor_auction_state($1) s", [f.rfqId]))!.s);
    expect(Object.keys(s).sort()).toEqual(["auction_id", "bid_count", "current_price", "end_at", "initial_price", "max_next_bid", "min_decrement", "rank", "server_time", "start_at", "status"]);
    expect(Number(s.current_price)).toBe(5000);
    expect(s.rank).toBe(3);
    expect(s.bid_count).toBe(0);
    const text = JSON.stringify(s);
    expect(text).not.toContain("3900");
    expect(text).not.toContain("4000");
    expect(text).not.toContain(f.vendors[1].vendorId);
    const hist = await withUser(f.vendors[0].userId, async (db) => (await q1(db, "select vendor_bid_history($1) h", [f.auctionId]))!.h);
    expect(hist).toEqual([]);                                         // other vendor's bid is not in my history
    const peek = await withUser(f.vendors[0].userId, async (db) => (await q1(db, "select vendor_bid_history($1) h", [f.auctionId]))!.h);
    expect(peek.length).toBe(0);
  });

  it("an uninvited approved vendor gets nothing from the vendor_* functions", async () => {
    const f = await liveAuction({ prices: [5000] });
    const outsider = await mkVendor("approved", "Outsider");
    const s = await withUser(outsider.userId, async (db) => (await q1(db, "select vendor_auction_state($1) s", [f.rfqId]))!.s);
    expect(s).toBeNull();
    const h = await withUser(outsider.userId, async (db) => (await q1(db, "select vendor_bid_history($1) h", [f.auctionId]))!.h);
    expect(h).toEqual([]);
    expect(await count(outsider.userId, "rfqs")).toBe(0);
  });

  it("a pending (unapproved) vendor sees their own profile only and no RFQs", async () => {
    const f = await liveAuction({ prices: [5000] });
    const pending = await mkVendor("pending", "Pending");
    expect(await count(pending.userId, "vendors")).toBe(1);
    expect(await count(pending.userId, "rfqs")).toBe(0);
    expect((await bid(pending.userId, f.auctionId, 100)).code).toBe("NOT_ELIGIBLE");
  });
});

describe("staff role boundaries", () => {
  it("approvers are read-only on commercial data; managers cannot read credentials", async () => {
    const f = await liveAuction({ prices: [5000] });
    const r = await asUserTry(f.approverId, (db) => db.query("update rfqs set additional_terms='x' where id=$1", [f.rfqId]));
    expect(r.ok && (r.value as any).rowCount).toBe(0);
    const ins = await asUserTry(f.approverId, (db) => db.query("insert into auction_events(auction_id, event_type) values ($1,'x')", [f.auctionId]));
    expect(ins.ok).toBe(false);
    expect(await count(f.managerId, "user_credentials")).toBe(0);
    expect(await count(f.managerId, "sessions")).toBe(0);
    expect(await count(f.managerId, "bids")).toBeGreaterThanOrEqual(0);
    expect(await count(f.approverId, "vendor_offers")).toBeGreaterThan(0);          // approvers can read for decisions
  });

  it("only admins can create staff accounts or change roles", async () => {
    const f = await liveAuction({ prices: [5000] });
    const asManager = await asUserTry(f.managerId, (db) => q(db, "select admin_create_user('x@y.test','X',null,'admin','hash',true)"));
    expect(asManager.ok).toBe(false);
    const asAdmin = await asUserTry(f.adminId, (db) => q(db, "select admin_create_user($1,'New Approver',null,'approver','hash',true) id", [`new.${Date.now()}@g.test`]));
    expect(asAdmin.ok).toBe(true);
    const vendorRole = await asUserTry(f.adminId, (db) => q(db, "select admin_create_user($1,'V',null,'vendor','hash',true)", [`v.${Date.now()}@g.test`]));
    expect(vendorRole.ok).toBe(false);
    const promote = await asUserTry(f.managerId, (db) => db.query("update profiles set role='admin' where id=$1", [f.managerId]));
    expect(promote.ok).toBe(false);
  });
});
