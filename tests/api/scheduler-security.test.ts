import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { Client, until } from "../helpers/client";
import { BASE, Stack } from "../helpers/stack";

const stack = new Stack();
const local = (plusSec: number) => DateTime.now().setZone("Asia/Kolkata").plus({ seconds: plusSec }).toFormat("yyyy-LL-dd'T'HH:mm:ss");
const tick = () => fetch(`${BASE}/api/cron/tick`, { method: "POST", headers: { authorization: "Bearer cron-test-secret" } }).then((r) => r.json());
let manager: Client, V: Record<string, string> = {};

beforeAll(async () => {
  await stack.start({ RUN_SCHEDULER: "false" });          // drive time-based behaviour explicitly through /api/cron/tick
  manager = new Client(); await manager.login("manager@grainspan.demo");
  const list = (await manager.get("/api/vendors")).json.vendors as any[];
  for (const s of ["kalinga", "sagar"]) V[s] = list.find((v) => v.contact_email === `${s}@vendor.demo`).id;
}, 180_000);
afterAll(async () => { await stack.stop(); });

const mkRfq = async (deadlineSec: number) => {
  const r = await manager.post("/api/rfqs", {
    materialName: "Coal", requiredQtyMt: "500", minGcvArb: 4000, maxMoisturePct: 20, deliveryLocation: "Plant", minDecrement: "10", coaRequired: false,
    quotationDeadline: local(deadlineSec), auctionStartAt: local(deadlineSec + 3600), auctionEndAt: local(deadlineSec + 7200), invitedVendorIds: [V.kalinga, V.sagar] });
  expect(r.status).toBe(200);
  expect((await manager.post(`/api/rfqs/${r.json.id}/publish`)).status).toBe(200);
  return r.json.id as string;
};
const kinds = async (rfqId: string, kind: string) => stack.sql("select vendor_id, channel, status, payload from notifications where rfq_id=$1 and kind=$2 order by created_at", [rfqId, kind]);

describe("scheduler: time-driven behaviour", () => {
  it("sends quotation-deadline reminders once per window, only to vendors who have not submitted, and not for windows already open at publication", async () => {
    const rfqId = await mkRfq(7 * 3600);                                           // deadline in 7 h: no reminder window is open
    await tick();
    expect((await kinds(rfqId, "quotation_reminder")).length).toBe(0);
    // time passes: deadline is now 90 minutes away and the RFQ was published well before the 2 h window
    await stack.sql("update rfqs set published_at = now() - interval '6 hours', quotation_deadline = now() + interval '90 minutes', auction_start_at = now() + interval '3 hours', auction_end_at = now() + interval '4 hours' where id=$1", [rfqId]);
    // sagar has already submitted → must not be reminded
    const sagar = new Client(); await sagar.login("sagar@vendor.demo");
    expect((await sagar.put(`/api/vendor/rfqs/${rfqId}/offer`, { origin: "ID", gcvArb: 4100, moisturePct: 15, qtyOfferedMt: "300", initialForPrice: "5000", leadTimeDays: 10, submit: true })).status).toBe(200);
    await tick(); await tick();                                                     // second tick must not duplicate
    const rem = await kinds(rfqId, "quotation_reminder");
    expect(new Set(rem.map((r) => r.vendor_id))).toEqual(new Set([V.kalinga]));
    expect(rem.length).toBe(2);                                                     // e-mail + WhatsApp, once (the 24 h and 2 h windows are both open now → deduped per window)
    const windows = await stack.sql("select dedupe_key from notifications where rfq_id=$1 and kind='quotation_reminder' order by dedupe_key", [rfqId]);
    expect(windows.length).toBeGreaterThanOrEqual(2);
  });

  it("moves RFQs to qualification at the deadline, and opens/closes auctions and sends the closing reminder from the server clock alone", async () => {
    const rfqId = await mkRfq(7 * 3600);
    const kal = new Client(); await kal.login("kalinga@vendor.demo");
    const sag = new Client(); await sag.login("sagar@vendor.demo");
    for (const [c, p] of [[kal, "5200"], [sag, "5150"]] as const) expect((await c.put(`/api/vendor/rfqs/${rfqId}/offer`, { origin: "ID", gcvArb: 4100, moisturePct: 15, qtyOfferedMt: "300", initialForPrice: p, leadTimeDays: 10, submit: true })).status).toBe(200);
    // deadline passes
    await stack.sql("update rfqs set quotation_deadline = now() - interval '1 minute', auction_start_at = now() + interval '1 hour', auction_end_at = now() + interval '2 hours' where id=$1", [rfqId]);
    await tick();
    expect((await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status).toBe("qualification");
    const vs = (await manager.get(`/api/rfqs/${rfqId}`)).json.vendors;
    for (const v of vs) expect((await manager.post(`/api/offers/${v.offer_id}/qualify`, { status: "qualified" })).status).toBe(200);
    expect((await manager.post(`/api/rfqs/${rfqId}/schedule`, { startAt: local(3), endAt: local(600) })).status).toBe(200);
    // not yet: still scheduled
    expect((await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status).toBe("scheduled");
    await until(async () => { await tick(); return (await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status === "live"; }, 15000, 500);
    expect((await kinds(rfqId, "auction_open")).length).toBe(4);                      // 2 vendors × 2 channels
    // end is 10 minutes away: no closing reminder yet; bring it inside the 5-minute window
    await tick(); expect((await kinds(rfqId, "auction_closing_reminder")).length).toBe(0);
    await stack.sql("update auctions set end_at = now() + interval '4 minutes' where rfq_id=$1 and status='live'", [rfqId]);
    await tick(); await tick();
    expect((await kinds(rfqId, "auction_closing_reminder")).length).toBe(4);          // exactly once
    // the end time passes (no client involved): the server closes the auction and notifies
    await stack.sql("update auctions set start_at = now() - interval '1 hour', end_at = now() - interval '1 second' where rfq_id=$1 and status='live'", [rfqId]);
    const r = await tick();
    expect(r.auctionsClosed).toBe(1);
    expect((await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status).toBe("closed");
    expect((await kinds(rfqId, "auction_closed")).length).toBe(4);
    const late = await kal.post(`/api/auctions/${(await stack.sql("select id from auctions where rfq_id=$1", [rfqId]))[0].id}/bids`, { amount: "100", idempotencyKey: "late-bid-0001" });
    expect(late.json.error.code).toBe("AUCTION_CLOSED");
  });
});

describe("abuse protection & session controls", () => {
  it("expires idle sessions server-side and keeps absolute lifetime", async () => {
    const c = new Client(); await c.login("approver@grainspan.demo");
    expect((await c.get("/api/audit")).status).toBe(200);
    await stack.sql("update sessions set last_seen_at = now() - interval '2 hours' where user_id = (select id from profiles where email='approver@grainspan.demo')");
    expect((await c.get("/api/audit")).status).toBe(401);                            // idle timeout (60 min default)
    const d = new Client(); await d.login("approver@grainspan.demo");
    await stack.sql("update sessions set expires_at = now() - interval '1 second' where user_id = (select id from profiles where email='approver@grainspan.demo')");
    expect((await d.get("/api/audit")).status).toBe(401);                            // absolute lifetime
  });

  it("deactivating a user, or suspending a vendor, takes effect on the very next request", async () => {
    const admin = new Client(); await admin.login("admin@grainspan.demo");
    const mgr2 = new Client(); await mgr2.login("manager@grainspan.demo");
    const users = (await admin.get("/api/users")).json.users as any[];
    const m = users.find((u) => u.email === "manager@grainspan.demo");
    expect((await admin.post(`/api/users/${m.id}/active`, { active: false })).status).toBe(200);
    expect((await mgr2.get("/api/rfqs")).status).toBe(401);
    expect((await new Client().post("/api/auth/login", { email: "manager@grainspan.demo", password: "Demo@12345" })).status).toBe(401);
    expect((await admin.post(`/api/users/${admin.cookie ? (users.find((u) => u.email === "admin@grainspan.demo")).id : ""}/active`, { active: false })).status).toBe(400);   // cannot lock yourself out
    // vendor suspension
    const kal = new Client(); await kal.login("kalinga@vendor.demo");
    expect((await kal.get("/api/vendor/rfqs")).json.rfqs.length).toBeGreaterThan(0);
    await stack.sql("update vendors set status='suspended' where contact_email='kalinga@vendor.demo'");
    expect((await kal.get("/api/vendor/rfqs")).json.rfqs).toEqual([]);
  });

  it("forces a password change for admin-created accounts before any other API is usable", async () => {
    const admin = new Client(); await admin.login("admin@grainspan.demo");
    const created = await admin.post("/api/users", { email: "newapprover@grainspan.demo", fullName: "New Approver", role: "approver", password: "Temp0rary-Pass1" });
    expect(created.status).toBe(200);
    expect((await admin.post("/api/users", { email: "weak@grainspan.demo", fullName: "Weak", role: "approver", password: "short" })).status).toBe(400);
    const u = new Client(); const login = await u.login("newapprover@grainspan.demo", "Temp0rary-Pass1");
    expect(login.json).toMatchObject({ mustChangePassword: true, redirect: "/account/password" });
    const blocked = await u.get("/api/rfqs");
    expect(blocked.status).toBe(403); expect(blocked.json.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await fetch(`${BASE}/admin`, { headers: { cookie: u.cookie }, redirect: "manual" })).headers.get("location")).toContain("/account/password");
    expect((await u.post("/api/auth/change-password", { currentPassword: "Temp0rary-Pass1", newPassword: "Temp0rary-Pass1" })).status).toBe(400);   // must differ
    expect((await u.post("/api/auth/change-password", { currentPassword: "wrong", newPassword: "Br4nd-new-secret" })).status).toBe(400);
    expect((await u.post("/api/auth/change-password", { currentPassword: "Temp0rary-Pass1", newPassword: "Br4nd-new-secret" })).status).toBe(200);
    expect((await u.get("/api/rfqs")).status).toBe(200);
    expect((await new Client().post("/api/auth/login", { email: "newapprover@grainspan.demo", password: "Temp0rary-Pass1" })).status).toBe(401);   // old password is dead
  });

  it("rate-limits login attempts per IP", async () => {
    const c = new Client(); let limited = 0;
    for (let i = 0; i < 30; i++) { const r = await c.post("/api/auth/login", { email: `nobody${i}@x.test`, password: "whatever-123" }); if (r.status === 429) limited++; }
    expect(limited).toBeGreaterThan(0);
    const r = await c.post("/api/auth/login", { email: "x@x.test", password: "y" });
    expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBeTruthy();
  });
});
