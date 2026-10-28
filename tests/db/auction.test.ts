import { afterAll, describe, expect, it } from "vitest";
import { asUserTry, bid, closeAll, liveAuction, ownerQ, q, q1, withUser } from "../helpers/fixtures";

afterAll(closeAll);

describe("place_bid — rule enforcement", () => {
  it("accepts a valid decrement and updates rank, price and events", async () => {
    const f = await liveAuction({ prices: [5000, 5100], decrement: 10 });
    const [A, B] = f.vendors;
    const r = await bid(B.userId, f.auctionId, 4985);              // B was 5100, now 4985 (lower than A's 5000 → rank 1)
    expect(r.ok).toBe(true);
    expect(r.rank).toBe(1);
    expect(Number(r.bid.previous_amount)).toBe(5100);
    const ra = await withUser(A.userId, async (db) => (await q1(db, "select vendor_auction_state($1) s", [f.rfqId]))!.s);
    expect(ra.rank).toBe(2);
    expect(Number(ra.current_price)).toBe(5000);
    const ev = await ownerQ("select event_type from auction_events where auction_id=$1 order by id", [f.auctionId]);
    expect(ev.map((e: any) => e.event_type)).toContain("bid_accepted");
  });

  it("enforces the minimum decrement against the vendor's OWN current price, and records the rejection", async () => {
    const f = await liveAuction({ prices: [5000, 5100], decrement: 25 });
    const [A] = f.vendors;
    const tooSmall = await bid(A.userId, f.auctionId, 4980);        // only 20 below own 5000
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.code).toBe("BELOW_DECREMENT");
    const exact = await bid(A.userId, f.auctionId, 4975);           // exactly 25 below → allowed
    expect(exact.ok).toBe(true);
    const next = await bid(A.userId, f.auctionId, 4960);            // 15 below 4975 → rejected
    expect(next.code).toBe("BELOW_DECREMENT");
    const rej = await ownerQ("select payload from auction_events where auction_id=$1 and event_type='bid_rejected'", [f.auctionId]);
    expect(rej.length).toBe(2);
  });

  it("rejects upward and equal bids", async () => {
    const f = await liveAuction({ prices: [5000, 5100], decrement: 10 });
    const [A] = f.vendors;
    expect((await bid(A.userId, f.auctionId, 5200)).code).toBe("NOT_LOWER");
    expect((await bid(A.userId, f.auctionId, 5000)).code).toBe("NOT_LOWER");
    expect((await bid(A.userId, f.auctionId, 0)).code).toBe("INVALID_AMOUNT");
    expect((await bid(A.userId, f.auctionId, -5)).code).toBe("INVALID_AMOUNT");
    expect((await bid(A.userId, f.auctionId, "4990.555")).code).toBe("INVALID_AMOUNT");
    const n = await ownerQ("select count(*)::int c from bids where auction_id=$1", [f.auctionId]);
    expect(n[0].c).toBe(0);
  });

  it("is a no-op for competitors: a lower rival price does not relax or tighten MY rule", async () => {
    const f = await liveAuction({ prices: [5000, 5100], decrement: 10 });
    const [A, B] = f.vendors;
    await bid(A.userId, f.auctionId, 4000);
    const r = await bid(B.userId, f.auctionId, 5090);               // B's own price 5100 → 5090 fine though A is far lower
    expect(r.ok).toBe(true);
    expect(r.rank).toBe(2);
  });

  it("rejects bids after the auction closes (server clock) and before it starts", async () => {
    const closed = await liveAuction({ prices: [5000], endInSec: -5 });           // ended 5 s ago but status still 'live' (scheduler lag)
    expect((await bid(closed.vendors[0].userId, closed.auctionId, 4900)).code).toBe("AUCTION_CLOSED");
    const future = await liveAuction({ prices: [5000], startInSec: 600, endInSec: 1200 });
    expect((await bid(future.vendors[0].userId, future.auctionId, 4900)).code).toBe("AUCTION_NOT_STARTED");
    // explicit closed status
    const f = await liveAuction({ prices: [5000] });
    await ownerQ("update auctions set status='closed', closed_at=now() where id=$1", [f.auctionId]);
    expect((await bid(f.vendors[0].userId, f.auctionId, 4900)).code).toBe("AUCTION_CLOSED");
  });

  it("rejects ineligible callers (generic answer): other RFQ's vendor, unqualified vendor, staff, unknown auction, suspended vendor", async () => {
    const f = await liveAuction({ prices: [5000, 5100], pendingPrices: [4000] });
    const other = await liveAuction({ prices: [7000] });
    expect((await bid(other.vendors[0].userId, f.auctionId, 100)).code).toBe("NOT_ELIGIBLE");
    expect((await bid(f.pending[0].userId, f.auctionId, 3900)).code).toBe("NOT_ELIGIBLE");   // quoted but never qualified
    expect((await bid(f.managerId, f.auctionId, 100)).code).toBe("NOT_ELIGIBLE");
    expect((await bid(f.adminId, f.auctionId, 100)).code).toBe("NOT_ELIGIBLE");
    expect((await bid(f.vendors[0].userId, "00000000-0000-0000-0000-0000000000aa", 100)).code).toBe("NOT_ELIGIBLE");
    await ownerQ("update vendors set status='suspended' where id=$1", [other.vendors[0].vendorId]);
    expect((await bid(other.vendors[0].userId, other.auctionId, 6000)).code).toBe("NOT_ELIGIBLE");
    const n = await ownerQ("select count(*)::int c from bids where auction_id = any($1)", [[f.auctionId, other.auctionId]]);
    expect(n[0].c).toBe(0);
  });

  it("is idempotent: a retried request with the same key returns the original bid and never double-applies", async () => {
    const f = await liveAuction({ prices: [5000], decrement: 10 });
    const [A] = f.vendors;
    const first = await bid(A.userId, f.auctionId, 4900, "retry-key-0001");
    const second = await bid(A.userId, f.auctionId, 4900, "retry-key-0001");
    expect(first.ok && second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.bid.id).toBe(first.bid.id);
    const n = await ownerQ("select count(*)::int c from bids where auction_id=$1", [f.auctionId]);
    expect(n[0].c).toBe(1);
  });
});

describe("place_bid — concurrency", () => {
  it("serialises 40 simultaneous bids from two vendors; every accepted bid is consistent with the previous accepted bid", async () => {
    const f = await liveAuction({ prices: [100000, 100000], decrement: 10 });
    const [A, B] = f.vendors;
    const jobs: Promise<any>[] = [];
    // Each vendor fires 20 bids at once, at prices 99990, 99980, ... (only a strictly decreasing subsequence can all be accepted)
    for (let i = 1; i <= 20; i++) {
      jobs.push(bid(A.userId, f.auctionId, 100000 - i * 10));
      jobs.push(bid(B.userId, f.auctionId, 100000 - i * 10));
    }
    const res = await Promise.all(jobs);
    expect(res.every((r) => r.ok === true || ["NOT_LOWER", "BELOW_DECREMENT"].includes(r.code))).toBe(true);
    for (const v of [A, B]) {
      const rows = await ownerQ("select seq, amount, previous_amount from bids where auction_id=$1 and vendor_id=$2 order by seq", [f.auctionId, v.vendorId]);
      expect(rows.length).toBeGreaterThan(0);
      let prev = 100000;
      for (const r of rows) {
        expect(Number(r.previous_amount)).toBe(prev);            // chain integrity: no lost update
        expect(prev - Number(r.amount)).toBeGreaterThanOrEqual(10); // decrement honoured for every accepted bid
        prev = Number(r.amount);
      }
    }
    const ranks = await withUser(f.managerId, (db) => q(db, "select rank from admin_standings($1) order by rank", [f.rfqId]));
    expect(ranks.map((r: any) => r.rank)).toEqual([1, 2]);          // unique, gap-free ranking even under contention
  });

  it("when one vendor submits the SAME price concurrently with different keys only one is accepted", async () => {
    const f = await liveAuction({ prices: [5000], decrement: 10 });
    const [A] = f.vendors;
    const res = await Promise.all(Array.from({ length: 15 }, () => bid(A.userId, f.auctionId, 4900)));
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect(res.filter((r) => !r.ok).every((r) => r.code === "NOT_LOWER")).toBe(true);
  });
});

describe("ranking and tie-breaking", () => {
  it("equal prices rank by who reached the price first; ranks are always a unique permutation", async () => {
    const f = await liveAuction({ prices: [5000, 5000, 5000], decrement: 10 });
    const [A, B, C] = f.vendors;
    // all start tied at 5000 → tie-break on quotation submission time (A, B, C order of submission)
    const st = async (u: string) => withUser(u, async (db) => (await q1(db, "select vendor_auction_state($1) s", [f.rfqId]))!.s.rank);
    expect([await st(A.userId), await st(B.userId), await st(C.userId)]).toEqual([1, 2, 3]);
    // C reaches 4900 first, then B matches 4900 later → C ahead of B
    await bid(C.userId, f.auctionId, 4900);
    await bid(B.userId, f.auctionId, 4900);
    expect([await st(C.userId), await st(B.userId), await st(A.userId)]).toEqual([1, 2, 3]);
    // A undercuts both
    await bid(A.userId, f.auctionId, 4890);
    expect([await st(A.userId), await st(C.userId), await st(B.userId)]).toEqual([1, 2, 3]);
  });

  it("only qualified vendors are ranked", async () => {
    const f = await liveAuction({ prices: [5000, 4000] });
    // third vendor with a pending quotation is not ranked
    const rows = await withUser(f.managerId, (db) => q(db, "select vendor_id, rank from admin_standings($1) order by rank", [f.rfqId]));
    expect(rows.length).toBe(2);
    expect(rows[0].vendor_id).toBe(f.vendors[1].vendorId);
  });
});

describe("auction extension", () => {
  it("extends the end time when a bid lands inside the trigger window and honours the maximum", async () => {
    const f = await liveAuction({ prices: [5000], decrement: 10, endInSec: 60,
      ext: { ext_enabled: true, ext_trigger_seconds: 120, ext_duration_seconds: 100, ext_max_count: 2 } });
    const [A] = f.vendors;
    const before = (await ownerQ("select end_at from auctions where id=$1", [f.auctionId]))[0].end_at as Date;
    const r1 = await bid(A.userId, f.auctionId, 4990);
    expect(r1.ok && r1.extended).toBe(true);
    const mid = (await ownerQ("select end_at, extension_count from auctions where id=$1", [f.auctionId]))[0];
    expect(new Date(mid.end_at).getTime()).toBeGreaterThan(new Date(before).getTime() + 30_000);
    expect(mid.extension_count).toBe(1);
    expect((await bid(A.userId, f.auctionId, 4980)).extended).toBe(true);
    const r3 = await bid(A.userId, f.auctionId, 4970);                // max_count=2 reached
    expect(r3.ok).toBe(true);
    expect(r3.extended).toBe(false);
    const ev = await ownerQ("select count(*)::int c from auction_events where auction_id=$1 and event_type='auction_extended'", [f.auctionId]);
    expect(ev[0].c).toBe(2);
  });

  it("does not extend when disabled or when the bid is outside the window", async () => {
    const off = await liveAuction({ prices: [5000], endInSec: 30 });
    expect((await bid(off.vendors[0].userId, off.auctionId, 4990)).extended).toBe(false);
    const far = await liveAuction({ prices: [5000], endInSec: 3000, ext: { ext_enabled: true } });
    expect((await bid(far.vendors[0].userId, far.auctionId, 4990)).extended).toBe(false);
  });
});

describe("append-only data", () => {
  it("bids, auction_events and audit_logs reject UPDATE/DELETE/TRUNCATE even for the table owner", async () => {
    const f = await liveAuction({ prices: [5000] });
    await bid(f.vendors[0].userId, f.auctionId, 4900);
    await expect(ownerQ("update bids set amount = 1")).rejects.toThrow(/append-only/);
    await expect(ownerQ("delete from bids")).rejects.toThrow(/append-only/);
    await expect(ownerQ("truncate bids")).rejects.toThrow(/append-only/);
    await expect(ownerQ("update auction_events set payload='{}'")).rejects.toThrow(/append-only/);
    await expect(ownerQ("delete from audit_logs")).rejects.toThrow(/append-only/);
  });

  it("the application role has no INSERT/UPDATE/DELETE privilege on bids", async () => {
    const f = await liveAuction({ prices: [5000] });
    const ins = await asUserTry(f.vendors[0].userId, (db) => db.query(
      "insert into bids(auction_id,rfq_id,vendor_id,offer_id,user_id,amount,previous_amount,idempotency_key) values ($1,$2,$3,$4,$5,1,2,'forged-key')",
      [f.auctionId, f.rfqId, f.vendors[0].vendorId, f.vendors[0].offerId, f.vendors[0].userId]));
    expect(ins.ok).toBe(false);
    const upd = await asUserTry(f.managerId, (db) => db.query("update bids set amount = 1"));
    expect(upd.ok).toBe(false);
  });
});
