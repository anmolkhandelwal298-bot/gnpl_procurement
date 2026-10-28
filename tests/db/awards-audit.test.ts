import { afterAll, describe, expect, it } from "vitest";
import { asUserTry, bid, closeAll, liveAuction, mkUser, owner, ownerQ, q, q1, withUser } from "../helpers/fixtures";

afterAll(closeAll);

/** Live auction with 3 vendors (offered 500/400/300 MT, required 1000 MT) that has been bid on and then closed. */
async function closedAuction() {
  const f = await liveAuction({ prices: [5000, 5100, 5200], qty: [500, 400, 300], decrement: 10 });
  await bid(f.vendors[1].userId, f.auctionId, 4800);
  await bid(f.vendors[0].userId, f.auctionId, 4900);
  await bid(f.vendors[2].userId, f.auctionId, 5100);
  await withUser(f.managerId, async (db) => {
    await db.query("update auctions set status='closed', closed_at=clock_timestamp(), end_at=least(end_at, clock_timestamp()), close_reason='manual', closed_by=$2 where id=$1", [f.auctionId, f.managerId]);
    await db.query("update rfqs set status='closed' where id=$1", [f.rfqId]);
  });
  return f;
}
const alloc = (f: any, who: number, qty: number, remarks?: string) => withUser(f.managerId, async (db) => {
  const v = f.vendors[who];
  await db.query(`insert into allocations(rfq_id, vendor_id, offer_id, allocated_qty_mt, remarks) values ($1,$2,$3,$4,$5)
                  on conflict (rfq_id, vendor_id) do update set allocated_qty_mt = excluded.allocated_qty_mt, remarks = excluded.remarks`,
    [f.rfqId, v.vendorId, v.offerId, qty, remarks ?? null]);
});

describe("manual quantity allocation validation", () => {
  it("accepts a multi-vendor split that is below or equal to the requirement", async () => {
    const f = await closedAuction();
    await alloc(f, 1, 400); await alloc(f, 0, 350); await alloc(f, 2, 250);          // 1000 total — exactly the requirement
    expect((await ownerQ("select sum(allocated_qty_mt)::numeric s from allocations where rfq_id=$1", [f.rfqId]))[0].s).toBe("1000.000");
    await alloc(f, 2, 100);                                                           // under-award is allowed
    expect((await ownerQ("select sum(allocated_qty_mt)::numeric s from allocations where rfq_id=$1", [f.rfqId]))[0].s).toBe("850.000");
  });

  it("rejects negative quantities, over-offered quantities and totals above the requirement", async () => {
    const f = await closedAuction();
    await expect(alloc(f, 0, -1)).rejects.toThrow(/allocated_qty_mt_check|check constraint/);
    await expect(alloc(f, 2, 301)).rejects.toThrow(/OVER_OFFERED/);                  // vendor C offered 300
    await alloc(f, 0, 500); await alloc(f, 1, 400);                                   // 900
    await expect(alloc(f, 2, 200)).rejects.toThrow(/OVER_REQUIREMENT/);              // 1100 > 1000 (checked at commit)
    expect((await ownerQ("select count(*)::int c from allocations where rfq_id=$1", [f.rfqId]))[0].c).toBe(2);
  });

  it("allows an in-transaction swap of quantities (deferred total check) and blocks edits before the auction closes", async () => {
    const f = await closedAuction();
    await alloc(f, 0, 500); await alloc(f, 1, 400);
    await withUser(f.managerId, async (db) => {
      await db.query("update allocations set allocated_qty_mt = 100 where vendor_id=$1 and rfq_id=$2", [f.vendors[0].vendorId, f.rfqId]);
      await db.query("update allocations set allocated_qty_mt = 400 where vendor_id=$1 and rfq_id=$2", [f.vendors[1].vendorId, f.rfqId]);
    });
    const live = await liveAuction({ prices: [5000] });
    const tooEarly = await asUserTry(live.managerId, (db) => db.query(
      "insert into allocations(rfq_id, vendor_id, offer_id, allocated_qty_mt) values ($1,$2,$3,10)", [live.rfqId, live.vendors[0].vendorId, live.vendors[0].offerId]));
    expect(tooEarly.ok).toBe(false);
    expect((tooEarly as any).message).toMatch(/INVALID_STATE/);
  });

  it("refuses allocation to an unqualified vendor and to roles without permission", async () => {
    const f = await liveAuction({ prices: [5000], pendingPrices: [4000] });
    await withUser(f.managerId, async (db) => {
      await db.query("update auctions set status='closed', closed_at=now() where id=$1", [f.auctionId]);
      await db.query("update rfqs set status='closed' where id=$1", [f.rfqId]);
    });
    const unq = await asUserTry(f.managerId, (db) => db.query(
      "insert into allocations(rfq_id, vendor_id, offer_id, allocated_qty_mt) values ($1,$2,$3,10)", [f.rfqId, f.pending[0].vendorId, f.pending[0].offerId]));
    expect(unq.ok).toBe(false);
    expect((unq as any).message).toMatch(/NOT_QUALIFIED/);
    const approver = await asUserTry(f.approverId, (db) => db.query(
      "insert into allocations(rfq_id, vendor_id, offer_id, allocated_qty_mt) values ($1,$2,$3,10)", [f.rfqId, f.vendors[0].vendorId, f.vendors[0].offerId]));
    expect(approver.ok).toBe(false);
    const vendor = await asUserTry(f.vendors[0].userId, (db) => db.query(
      "insert into allocations(rfq_id, vendor_id, offer_id, allocated_qty_mt) values ($1,$2,$3,10)", [f.rfqId, f.vendors[0].vendorId, f.vendors[0].offerId]));
    expect(vendor.ok).toBe(false);
  });
});

describe("award approval workflow", () => {
  const newCycle = (f: any) => withUser(f.managerId, (db) => db.query("insert into award_approvals(rfq_id) values ($1)", [f.rfqId]));
  const setStatus = (userId: string, f: any, status: string, remarks?: string) => asUserTry(userId, (db) =>
    db.query("update award_approvals set status=$2, decision_remarks=coalesce($3, decision_remarks) where rfq_id=$1 and status not in ('rejected','published')", [f.rfqId, status, remarks ?? null]));

  it("draft → submitted → approved → published, with correct roles and a frozen snapshot", async () => {
    const f = await closedAuction();
    await alloc(f, 1, 400, "L1"); await alloc(f, 0, 350, "L2"); await alloc(f, 2, 250, "L3");
    await newCycle(f);
    expect((await setStatus(f.approverId, f, "submitted")).ok).toBe(false);          // approvers cannot submit
    expect((await setStatus(f.managerId, f, "submitted")).ok).toBe(true);
    const sub = (await ownerQ("select snapshot, total_allocated_mt, total_value from award_approvals where rfq_id=$1", [f.rfqId]))[0];
    expect(sub.total_allocated_mt).toBe("1000.000");
    expect(sub.snapshot.map((l: any) => [l.rank, Number(l.final_price), Number(l.allocated_qty_mt)])).toEqual([[1, 4800, 400], [2, 4900, 350], [3, 5100, 250]]);
    expect(sub.total_value).toBe("4910000.00");                                       // 400*4800 + 350*4900 + 250*5100
    // allocations are now locked
    expect((await asUserTry(f.managerId, (db) => db.query("update allocations set allocated_qty_mt=1 where rfq_id=$1", [f.rfqId]))).ok).toBe(false);
    // the submitter cannot approve; a manager cannot approve; the approver can
    expect((await setStatus(f.managerId, f, "approved")).ok).toBe(false);
    expect((await setStatus(f.approverId, f, "approved")).ok).toBe(true);
    expect((await setStatus(f.managerId, f, "published")).ok).toBe(false);
    expect((await setStatus(f.approverId, f, "published")).ok).toBe(true);
    expect((await ownerQ("select status from rfqs where id=$1", [f.rfqId]))[0].status).toBe("awarded");   // flipped atomically on publish
  });

  it("enforces separation of duties even for administrators", async () => {
    const f = await closedAuction();
    await alloc(f, 0, 100);
    await newCycle(f);
    expect((await setStatus(f.adminId, f, "submitted")).ok).toBe(true);              // admin may submit...
    const self: any = await setStatus(f.adminId, f, "approved");                      // ...but not approve their own submission
    expect(self.ok).toBe(false);
    expect(self.message).toMatch(/SEPARATION_OF_DUTIES/);
    const other = await mkUser("admin", "Second admin");
    expect((await setStatus(other, f, "approved")).ok).toBe(true);
  });

  it("rejection needs remarks, unlocks editing via a new cycle, and keeps the rejected cycle in history", async () => {
    const f = await closedAuction();
    await alloc(f, 0, 500);
    await newCycle(f);
    await setStatus(f.managerId, f, "submitted");
    const noReason: any = await setStatus(f.approverId, f, "rejected");
    expect(noReason.ok).toBe(false);
    expect((await setStatus(f.approverId, f, "rejected", "Quantity too concentrated on one supplier")).ok).toBe(true);
    await alloc(f, 0, 300); await alloc(f, 1, 400);                                   // editable again
    await newCycle(f);
    const cycles = await ownerQ("select cycle_no, status from award_approvals where rfq_id=$1 order by cycle_no", [f.rfqId]);
    expect(cycles).toEqual([{ cycle_no: 1, status: "rejected" }, { cycle_no: 2, status: "draft" }]);
    expect((await asUserTry(f.managerId, (db) => db.query("update award_approvals set status='draft' where cycle_no=1 and rfq_id=$1", [f.rfqId]))).ok).toBe(false);
  });

  it("an empty allocation cannot be submitted, and the RFQ cannot be marked awarded without a published award", async () => {
    const f = await closedAuction();
    await newCycle(f);
    const empty: any = await setStatus(f.managerId, f, "submitted");
    expect(empty.ok).toBe(false);
    expect(empty.message).toMatch(/EMPTY_ALLOCATION/);
    const forced: any = await asUserTry(f.adminId, (db) => db.query("update rfqs set status='awarded' where id=$1", [f.rfqId]));
    expect(forced.ok).toBe(false);
    expect(forced.message).toMatch(/no published award/);
  });

  it("vendors see their award only after publication, and only their own line", async () => {
    const f = await closedAuction();
    await alloc(f, 1, 400); await alloc(f, 0, 500);
    await newCycle(f);
    const res = (i: number) => withUser(f.vendors[i].userId, async (db) => (await q1(db, "select vendor_award_result($1) r", [f.rfqId]))!.r);
    await setStatus(f.managerId, f, "submitted");
    await setStatus(f.approverId, f, "approved");
    expect(await res(0)).toEqual({ published: false });                               // approved is not yet visible to vendors
    await setStatus(f.approverId, f, "published");
    const a = await res(0), b = await res(1), c = await res(2);
    expect(a).toMatchObject({ published: true, awarded: true, allocated_qty_mt: 500 });
    expect(b).toMatchObject({ published: true, awarded: true, allocated_qty_mt: 400, final_price: 4800 });
    expect(c).toMatchObject({ published: true, awarded: false, allocated_qty_mt: 0 });
    expect(JSON.stringify(a)).not.toContain("4800");                                  // does not leak the other vendor's price
    expect(Object.keys(b).sort()).toEqual(["allocated_qty_mt", "awarded", "final_price", "published", "published_at", "value"]);
  });
});

describe("audit trail", () => {
  it("records allocation, qualification, status and bid-adjacent changes with actor and before/after values", async () => {
    const f = await closedAuction();
    await alloc(f, 0, 500, "first");
    await alloc(f, 0, 450, "reduced");
    const rows = await ownerQ(`select action, actor_role, before, after from audit_logs where rfq_id=$1 and entity_type='allocation' order by id`, [f.rfqId]);
    expect(rows.map((r: any) => r.action)).toEqual(["allocation.create", "allocation.update"]);
    expect(rows[1].actor_role).toBe("procurement_manager");
    expect(Number(rows[1].before.allocated_qty_mt)).toBe(500);
    expect(Number(rows[1].after.allocated_qty_mt)).toBe(450);
    const status = await ownerQ(`select count(*)::int c from audit_logs where rfq_id=$1 and action='rfq.status_change'`, [f.rfqId]);
    expect(status[0].c).toBeGreaterThanOrEqual(5);
    const qual = await ownerQ(`select after from audit_logs where entity_type='offer' and entity_id=$1 and after ? 'qualification_status'`, [f.vendors[0].offerId]);
    expect(qual.length).toBeGreaterThan(0);
  });

  it("never stores password hashes or document bytes in audit rows", async () => {
    await mkUser("approver");
    const leaks = await ownerQ(`select count(*)::int c from audit_logs where after::text ilike '%password_hash%' or before::text ilike '%password_hash%'`);
    expect(leaks[0].c).toBe(0);
  });

  it("the hash chain verifies; tampering with any row, or deleting history, is detected", async () => {
    const f = await closedAuction();
    await alloc(f, 0, 100);
    const ok = await withUser(f.adminId, (db) => q(db, "select * from verify_audit_chain()"));
    expect(ok[0]).toMatchObject({ ok: true, first_bad_seq: null });
    expect(Number(ok[0].checked)).toBeGreaterThan(20);

    // Tamper inside a transaction that is rolled back, so the shared test database chain stays intact.
    const c = await owner();
    const verify = async () => (await c.query("select * from verify_audit_chain()")).rows[0];
    const [victim] = (await c.query("select id, chain_seq from audit_logs where entity_type='allocation' order by id desc limit 1")).rows;
    await c.query("begin");
    try {
      await c.query("select set_config('app.mode','system',true)");
      await c.query("set local session_replication_role = replica");        // an attacker with owner rights disables the triggers
      await c.query("update audit_logs set after = jsonb_set(after, '{allocated_qty_mt}', '1') where id=$1", [victim.id]);
      const bad = await verify();
      expect(bad.ok).toBe(false);
      expect(Number(bad.first_bad_seq)).toBe(Number(victim.chain_seq));
      expect(bad.reason).toMatch(/does not match its hash/);
    } finally { await c.query("rollback"); }

    await c.query("begin");
    try {
      await c.query("select set_config('app.mode','system',true)");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from audit_logs where id = (select max(id) from audit_logs)");   // dropping the newest entry
      const gone = await verify();
      expect(gone.ok).toBe(false);
      expect(gone.reason).toMatch(/chain head/);
    } finally { await c.query("rollback"); }

    await c.query("begin");
    try {
      await c.query("select set_config('app.mode','system',true)");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from audit_logs where id = (select id from audit_logs order by id limit 1 offset 5)");   // removing a row mid-history
      expect((await verify()).ok).toBe(false);
    } finally { await c.query("rollback"); }
    expect((await withUser(f.adminId, (db) => q(db, "select * from verify_audit_chain()")))[0].ok).toBe(true);
  });

  it("audit rows are visible to staff only and cannot be forged by the application role", async () => {
    const f = await closedAuction();
    expect((await withUser(f.approverId, (db) => q(db, "select count(*)::int c from audit_logs")))[0].c).toBeGreaterThan(0);
    expect((await withUser(f.vendors[0].userId, (db) => q(db, "select count(*)::int c from audit_logs")))[0].c).toBe(0);
    expect((await asUserTry(f.adminId, (db) => db.query("insert into audit_logs(chain_seq,action,entity_type,prev_hash,row_hash) values (999999,'x','x','x','x')"))).ok).toBe(false);
    expect((await asUserTry(f.adminId, (db) => db.query("delete from audit_logs"))).ok).toBe(false);
  });
});
