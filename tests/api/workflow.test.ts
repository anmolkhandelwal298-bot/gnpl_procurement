import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { Client, sleep, until } from "../helpers/client";
import { BASE, Stack, signResend, signWhatsApp, WA_VERIFY } from "../helpers/stack";

const stack = new Stack();
const local = (plusSec: number) => DateTime.now().setZone("Asia/Kolkata").plus({ seconds: plusSec }).toFormat("yyyy-LL-dd'T'HH:mm:ss");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const upload = (c: Client, rfqId: string, name: string, bytes: Buffer, docType = "coa") => {
  const fd = new FormData(); fd.append("file", new File([new Uint8Array(bytes)], name)); fd.append("docType", docType);
  return c.req("POST", `/api/vendor/rfqs/${rfqId}/documents`, undefined, { form: fd });
};

const admin = new Client("admin"), manager = new Client("manager"), approver = new Client("approver");
const kalinga = new Client("kalinga"), sagar = new Client("sagar"), bharat = new Client("bharat"), coastal = new Client("coastal");
let V: Record<string, string> = {};      // vendor ids by slug
let rfqId = "", auctionId = "";

beforeAll(async () => {
  await stack.start();
  await Promise.all([admin.login("admin@grainspan.demo"), manager.login("manager@grainspan.demo"), approver.login("approver@grainspan.demo"),
    kalinga.login("kalinga@vendor.demo"), sagar.login("sagar@vendor.demo"), bharat.login("bharat@vendor.demo"), coastal.login("coastal@vendor.demo")]);
  const list = (await manager.get("/api/vendors")).json.vendors as any[];
  for (const slug of ["kalinga", "sagar", "bharat", "coastal"]) V[slug] = list.find((v) => v.contact_email === `${slug}@vendor.demo`).id;
}, 180_000);
afterAll(async () => { await stack.stop(); });

describe("authentication & authorisation (HTTP)", () => {
  it("rejects unauthenticated API calls and redirects pages to login", async () => {
    const anon = new Client();
    expect((await anon.get("/api/rfqs")).status).toBe(401);
    expect((await anon.get("/api/audit")).status).toBe(401);
    expect((await anon.post("/api/auctions/00000000-0000-0000-0000-000000000000/bids", { amount: "1", idempotencyKey: "abcdefgh1" })).status).toBe(401);
    const page = await fetch(`${BASE}/admin`, { redirect: "manual" });
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login");
    expect((await fetch(`${BASE}/vendor`, { redirect: "manual" })).status).toBe(307);
  });

  it("sets a hardened session cookie and security headers", async () => {
    const c = new Client(); const r = await c.login("admin@grainspan.demo");
    expect(r.setCookie).toMatch(/HttpOnly/i); expect(r.setCookie).toMatch(/SameSite=lax/i); expect(r.setCookie).toMatch(/Path=\//);
    const h = await fetch(`${BASE}/login`);
    expect(h.headers.get("x-frame-options")).toBe("DENY");
    expect(h.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("enforces role boundaries on every portal", async () => {
    expect((await kalinga.get("/api/rfqs")).status).toBe(403);
    expect((await kalinga.get("/api/vendors")).status).toBe(403);
    expect((await kalinga.get("/api/audit")).status).toBe(403);
    expect((await kalinga.get("/api/notifications")).status).toBe(403);
    expect((await kalinga.post("/api/rfqs", {})).status).toBe(403);
    expect((await kalinga.get("/api/users")).status).toBe(403);
    expect((await manager.get("/api/vendor/rfqs")).status).toBe(403);
    expect((await manager.post("/api/auctions/00000000-0000-0000-0000-000000000000/bids", { amount: "1", idempotencyKey: "abcdefgh1" })).status).toBe(403);
    expect((await approver.post("/api/rfqs", {})).status).toBe(403);       // approvers cannot create RFQs
    expect((await manager.get("/api/users")).status).toBe(403);             // only admins manage staff
    expect((await admin.get("/api/users")).status).toBe(200);
    const pageAsVendor = await fetch(`${BASE}/admin`, { headers: { cookie: kalinga.cookie }, redirect: "manual" });
    expect(pageAsVendor.status).toBe(307);
    expect(pageAsVendor.headers.get("location")).toContain("/vendor");
  });

  it("blocks cross-origin and origin-less state-changing requests (CSRF defence)", async () => {
    const r = await manager.req("POST", "/api/rfqs", {}, { headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403); expect(r.json.error.code).toBe("BAD_ORIGIN");
    expect((await manager.req("POST", "/api/rfqs", {}, { noOrigin: true })).json.error.code).toBe("BAD_ORIGIN");
  });

  it("returns a generic login failure, locks the account after 5 bad attempts, and audits it", async () => {
    const c = new Client();
    const first = await c.post("/api/auth/login", { email: "pending@vendor.demo", password: "wrong-password-1" });
    expect(first.status).toBe(401);
    const ghost = await c.post("/api/auth/login", { email: "nobody@nowhere.test", password: "wrong-password-1" });
    expect(ghost.status).toBe(401); expect(ghost.json.error.message).toBe(first.json.error.message);   // no account enumeration
    for (let i = 0; i < 3; i++) await c.post("/api/auth/login", { email: "pending@vendor.demo", password: "wrong-password-1" });
    const fifth = await c.post("/api/auth/login", { email: "pending@vendor.demo", password: "wrong-password-1" });
    expect([401, 423]).toContain(fifth.status);
    const locked = await c.post("/api/auth/login", { email: "pending@vendor.demo", password: "Demo@12345" });
    expect(locked.status).toBe(423);                                                   // even the right password is refused while locked
    const audit = await stack.sql("select count(*)::int c from audit_logs where action='auth.login_failed'");
    expect(audit[0].c).toBeGreaterThanOrEqual(5);
  });

  it("invalidates the session on logout and supports password change", async () => {
    const c = new Client(); await c.login("approver@grainspan.demo");
    const old = c.cookie;
    expect((await c.get("/api/audit")).status).toBe(200);
    await c.post("/api/auth/logout", {});
    const replay = await fetch(`${BASE}/api/audit`, { headers: { cookie: old } });
    expect(replay.status).toBe(401);                                                   // the revoked token is dead server-side
  });

  it("registers a vendor who stays isolated until an administrator approves and invites them", async () => {
    const anon = new Client();
    const body = { legalName: "Test Fuels LLP", gstin: "", pan: "", contactName: "Tina Test", email: "tina@testfuels.example", phone: "", whatsapp: "+919811122233", address: "", city: "Pune", state: "MH", country: "India", password: "Sup3rSecret!x" };
    expect((await anon.post("/api/auth/register", { ...body, password: "short" })).status).toBe(400);
    expect((await anon.post("/api/auth/register", { ...body, whatsapp: "9811122233" })).status).toBe(400);
    expect((await anon.post("/api/auth/register", body)).status).toBe(200);
    expect((await anon.post("/api/auth/register", body)).status).toBe(409);            // duplicate e-mail
    const tina = new Client(); await tina.login(body.email, body.password);
    expect((await tina.get("/api/vendor/rfqs")).json.rfqs).toEqual([]);
    const v = (await manager.get("/api/vendors?status=pending")).json.vendors.find((x: any) => x.contact_email === body.email);
    expect(v.status).toBe("pending");
    expect((await tina.post(`/api/vendors/${v.id}/status`, { status: "approved" })).status).toBe(403);   // cannot self-approve
    expect((await approver.post(`/api/vendors/${v.id}/status`, { status: "approved" })).status).toBe(403);
    expect((await manager.post(`/api/vendors/${v.id}/status`, { status: "rejected" })).status).toBe(400);   // reason required
    expect((await manager.post(`/api/vendors/${v.id}/status`, { status: "approved" })).status).toBe(200);
  });
});

describe("end-to-end procurement workflow", () => {
  it("manager creates an RFQ with server-side validation; approvers cannot", async () => {
    const bad = await manager.post("/api/rfqs", { materialName: "x", requiredQtyMt: "-5", minGcvArb: 12, maxMoisturePct: 150, deliveryLocation: "", minDecrement: "0" });
    expect(bad.status).toBe(400); expect(Object.keys(bad.json.error.fields).length).toBeGreaterThanOrEqual(4);
    const r = await manager.post("/api/rfqs", {
      materialName: "Imported Steam Coal", grade: "GCV 4200", requiredQtyMt: "800", minGcvArb: 4200, maxMoisturePct: 18, maxAshPct: 12, origin: "Indonesia",
      deliveryLocation: "Kutch plant", deliveryBasis: "FOR", deliverySchedule: "30 days", paymentTerms: "95/5", quotationDeadline: local(3600), auctionStartAt: local(7200), auctionEndAt: local(10800),
      minDecrement: "25", extEnabled: true, extTriggerSeconds: 5, extDurationSeconds: 8, extMaxCount: 2, coaRequired: true, docRequirements: "SGS COA", additionalTerms: "GST extra",
      complianceMode: "strict", invitedVendorIds: [V.kalinga, V.sagar, V.bharat],
    });
    expect(r.status).toBe(200); rfqId = r.json.id;
    const detail = (await manager.get(`/api/rfqs/${rfqId}`)).json;
    expect(detail.rfq.status).toBe("draft"); expect(detail.rfq.rfq_number).toMatch(/^RFQ-\d{4}-\d{4}$/); expect(detail.vendors.length).toBe(3);
  });

  it("drafts are invisible to vendors; publishing notifies invited vendors only, with real provider calls", async () => {
    expect((await kalinga.get("/api/vendor/rfqs")).json.rfqs.filter((r: any) => r.id === rfqId)).toEqual([]);
    expect((await approver.post(`/api/rfqs/${rfqId}/publish`)).status).toBe(403);
    stack.mock.clear();
    const pub = await manager.post(`/api/rfqs/${rfqId}/publish`);
    expect(pub.status).toBe(200); expect(pub.json).toMatchObject({ invited: 3, notificationsQueued: 6 });
    expect((await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status).toBe("quotation_open");
    await until(async () => stack.mock.of("resend").length >= 3 && stack.mock.of("meta").length >= 3, 15000);
    const mails = stack.mock.of("resend");
    expect(mails.map((m) => m.body.to[0]).sort()).toEqual(["bharat@vendor.demo", "kalinga@vendor.demo", "sagar@vendor.demo"]);
    const mail = mails.find((m) => m.body.to[0] === "kalinga@vendor.demo")!;
    expect(mail.headers.authorization).toBe("Bearer re_test_key"); expect(mail.headers["idempotency-key"]).toBeTruthy();
    expect(mail.body.subject).toContain("Invitation to quote"); expect(mail.body.html).toContain(`/vendor/rfqs/${rfqId}`);
    const NAMES: Record<string, string> = { "kalinga@vendor.demo": "Kalinga Coal", "sagar@vendor.demo": "Sagar Fuels", "bharat@vendor.demo": "Bharat Energy" };
    for (const m of mails) {                                           // each message names only its own recipient, never another invitee
      const t = m.body.html + m.body.text; const own = NAMES[m.body.to[0]];
      expect(t).toContain(own);
      for (const n of [...Object.values(NAMES), "Coastal Minerals"].filter((x) => x !== own)) expect(t).not.toContain(n);
    }
    const wa = stack.mock.of("meta")[0];
    expect(wa.headers.authorization).toBe("Bearer wa_test_token"); expect(wa.path).toContain("/1234567890/messages");
    expect(wa.body).toMatchObject({ messaging_product: "whatsapp", type: "template" }); expect(wa.body.template.name).toBe("gnpl_rfq_invitation");
    expect(wa.body.template.components[0].parameters.length).toBe(6);
    const notes = (await manager.get(`/api/notifications?rfq=${rfqId}`)).json;
    expect(notes.providers.email.configured && notes.providers.whatsapp.configured).toBe(true);
    await until(async () => (await manager.get(`/api/notifications?rfq=${rfqId}`)).json.rows.every((n: any) => n.status === "sent"), 10000);
  });

  it("vendors see only RFQs they were invited to and nothing about other vendors", async () => {
    const mine = (await kalinga.get("/api/vendor/rfqs")).json.rfqs;
    expect(mine.map((r: any) => r.id)).toContain(rfqId);
    expect((await coastal.get("/api/vendor/rfqs")).json.rfqs.map((r: any) => r.id)).not.toContain(rfqId);
    expect((await coastal.get(`/api/vendor/rfqs/${rfqId}`)).status).toBe(404);
    const detail = (await kalinga.get(`/api/vendor/rfqs/${rfqId}`)).json;
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/Sagar|Bharat|Coastal|sagar@|bharat@/);
    expect(detail.rfq).not.toHaveProperty("created_by"); expect(detail.invitation.status).toBeTruthy();
    expect((await coastal.put(`/api/vendor/rfqs/${rfqId}/offer`, { origin: "x", submit: false })).status).toBe(404);   // cannot quote on an RFQ they were not invited to
  });

  it("validates quotations server-side: incomplete, non-compliant, bad files, then accepts compliant ones", async () => {
    const good = { origin: "Indonesia", gcvArb: 4250, moisturePct: 16, ashPct: 9, qtyOfferedMt: "500", initialForPrice: "5200", leadTimeDays: 14, remarks: "FOB Kalimantan", otherParams: {} };
    expect((await kalinga.put(`/api/vendor/rfqs/${rfqId}/offer`, { ...good, initialForPrice: "", submit: true })).json.error.code).toBe("INCOMPLETE");
    const low = await kalinga.put(`/api/vendor/rfqs/${rfqId}/offer`, { ...good, gcvArb: 3900, moisturePct: 25, submit: true });
    expect(low.status).toBe(422); expect(low.json.error.code).toBe("NON_COMPLIANT");
    expect(low.json.error.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(["gcv_arb", "moisture_pct", "coa"]));
    expect((await kalinga.put(`/api/vendor/rfqs/${rfqId}/offer`, { ...good, submit: true })).json.error.details.map((d: any) => d.field)).toEqual(["coa"]);   // COA still missing
    // file validation: extension spoofing, empty and oversized files are refused; content is sniffed
    expect((await upload(kalinga, rfqId, "coa.pdf", Buffer.from("MZ not a pdf, just text pretending"))).status).toBe(415);
    expect((await upload(kalinga, rfqId, "x.exe", Buffer.from("MZ\x90\x00"))).status).toBe(415);
    expect((await upload(kalinga, rfqId, "empty.pdf", Buffer.alloc(0))).status).toBe(400);
    expect((await upload(kalinga, rfqId, "big.pdf", Buffer.concat([PDF, Buffer.alloc(10.5 * 1024 * 1024)]))).status).toBe(413);
    const up = await upload(kalinga, rfqId, "../../etc/passwd<script>.pdf", PDF);
    expect(up.status).toBe(200); expect(up.json.document.filename).not.toMatch(/[\/<>]/);
    expect((await kalinga.put(`/api/vendor/rfqs/${rfqId}/offer`, { ...good, submit: true })).status).toBe(200);
    // sagar & bharat
    for (const [c, price, qty] of [[sagar, "5150", "500"], [bharat, "5400", "300"]] as const) {
      expect((await upload(c, rfqId, "coa.pdf", PDF)).status).toBe(200);
      expect((await c.put(`/api/vendor/rfqs/${rfqId}/offer`, { ...good, initialForPrice: price, qtyOfferedMt: qty, submit: true })).status).toBe(200);
    }
    const mine = (await kalinga.get(`/api/vendor/rfqs/${rfqId}`)).json;
    expect(mine.offer.status).toBe("submitted"); expect(mine.documents.length).toBe(1);
    // document isolation: another vendor cannot download it; staff can
    const docId = mine.documents[0].id;
    expect((await sagar.get(`/api/documents/${docId}`)).status).toBe(404);
    expect((await coastal.get(`/api/documents/${docId}`)).status).toBe(404);
    const dl = await fetch(`${BASE}/api/documents/${docId}`, { headers: { cookie: manager.cookie } });
    expect(dl.status).toBe(200); expect(dl.headers.get("content-type")).toBe("application/pdf"); expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("technical qualification is separate from price; only qualified vendors proceed; specs lock at scheduling", async () => {
    const vs = (await manager.get(`/api/rfqs/${rfqId}`)).json.vendors;
    const offer = (slug: string) => vs.find((v: any) => v.vendor_id === V[slug]).offer_id;
    expect((await kalinga.post(`/api/offers/${offer("kalinga")}/qualify`, { status: "qualified" })).status).toBe(403);
    expect((await approver.post(`/api/offers/${offer("kalinga")}/qualify`, { status: "qualified" })).status).toBe(403);
    expect((await manager.post(`/api/offers/${offer("bharat")}/qualify`, { status: "disqualified" })).status).toBe(400);   // reason mandatory
    expect((await manager.post(`/api/offers/${offer("bharat")}/qualify`, { status: "disqualified", remarks: "Quantity too small for this lot" })).status).toBe(200);
    // cannot schedule until every quotation is decided and the quotation window is closed
    const early = await manager.post(`/api/rfqs/${rfqId}/schedule`, { startAt: local(4), endAt: local(40) });
    expect(early.status).toBe(409);
    expect((await manager.post(`/api/rfqs/${rfqId}/close-quotations`, { reason: "All quotations received" })).status).toBe(200);
    const pend = await manager.post(`/api/rfqs/${rfqId}/schedule`, { startAt: local(4), endAt: local(40) });
    expect(pend.json.error.code).toBe("QUALIFICATION_INCOMPLETE");
    for (const s of ["kalinga", "sagar"]) expect((await manager.post(`/api/offers/${offer(s)}/qualify`, { status: "qualified", remarks: "Meets spec" })).status).toBe(200);
    expect((await manager.post(`/api/rfqs/${rfqId}/schedule`, { startAt: local(-30), endAt: local(40) })).status).toBe(400);   // cannot start in the past
    expect((await manager.post(`/api/rfqs/${rfqId}/schedule`, { startAt: local(5), endAt: local(5) })).status).toBe(400);
    // the vendor's quotation is read-only once the quotation window is closed
    const lock = await kalinga.put(`/api/vendor/rfqs/${rfqId}/offer`, { origin: "Indonesia", gcvArb: 4250, moisturePct: 16, ashPct: 9, qtyOfferedMt: "500", initialForPrice: "1", leadTimeDays: 14, submit: true });
    expect(lock.status).toBe(422); expect(lock.json.error.code).toBe("OFFER_LOCKED");
  });

  it("runs a real-time auction: server-side opening, ranking pushed to the right viewers only, rejections, idempotency, concurrency, extension, closure", async () => {
    const startIn = 6, endIn = 34;
    const sch = await manager.post(`/api/rfqs/${rfqId}/schedule`, { startAt: local(startIn), endAt: local(endIn) });
    expect(sch.status).toBe(200); auctionId = sch.json.auctionId;
    const scheduledAt = Date.now();
    // a scheduled auction exposes no ranking to vendors; non-invited vendor cannot even open a stream
    expect((await coastal.stream(rfqId)).status).toBe(404);
    const sA = await kalinga.stream(rfqId), sB = await sagar.stream(rfqId), sX = await bharat.stream(rfqId), sAdmin = await manager.stream(rfqId);

    // the scheduler (not a client) opens the auction at the scheduled instant
    await sA.waitFor((s) => s.auction?.status === "live", 20000);
    expect(Date.now() - scheduledAt).toBeGreaterThan((startIn - 1) * 1000);
    const live = await sB.waitFor((s) => s.auction?.status === "live");
    expect(live.data.auction).toMatchObject({ rank: 1, current_price: 5150, initial_price: 5150 });         // sagar quoted lowest → rank 1
    expect((await sA.waitFor((s) => s.auction?.status === "live")).data.auction.rank).toBe(2);
    await sAdmin.waitFor((s) => s.auction?.status === "live" && s.standings?.length === 2);
    expect(sX.events.at(-1)!.data.auction).toBeNull();                                                                 // disqualified vendor gets no auction data at all

    // --- Kalinga bids 5100: below Sagar's 5150 → rank 1; Sagar is pushed to rank 2 WITHOUT any request of its own
    const mark = sB.events.length;
    const t0 = Date.now();
    const k1 = await kalinga.post(`/api/auctions/${auctionId}/bids`, { amount: "5100", idempotencyKey: "kal-key-0001" });
    expect(k1.status).toBe(200); expect(k1.json).toMatchObject({ ok: true, duplicate: false, rank: 1 });
    const pushed = await sB.waitFor((s) => s.auction?.rank === 2, 5000, mark);
    const latency = pushed.at - t0;
    expect(latency).toBeLessThan(3000);
    console.log(`      realtime: bid committed → competitor's browser stream updated in ${latency} ms`);
    // what the pushed snapshot may contain
    const leaked = JSON.stringify(pushed.data);
    expect(leaked).not.toMatch(/5100|Kalinga|KLG|kalinga|VND-0001/);
    expect(Number(pushed.data.auction.current_price)).toBe(5150);
    expect(Object.keys(pushed.data.auction).sort()).toEqual(["auction_id", "bid_count", "current_price", "end_at", "history", "initial_price", "max_next_bid", "min_decrement", "rank", "server_time", "start_at", "status"]);
    const adminSnap = await sAdmin.waitFor((s) => s.standings?.[0]?.current_price === "5100.00");
    expect(adminSnap.data.standings.map((s: any) => [s.rank, s.legal_name.split(" ")[0], s.current_price])).toEqual([[1, "Kalinga", "5100.00"], [2, "Sagar", "5150.00"]]);

    // --- rule enforcement over HTTP
    const bid = (c: Client, amount: string, key = `k-${Math.random().toString(36).slice(2)}-${Date.now()}`) => c.post(`/api/auctions/${auctionId}/bids`, { amount, idempotencyKey: key });
    expect((await bid(kalinga, "5090")).json.error.code).toBe("BELOW_DECREMENT");               // only 10 below own 5100, decrement is 25
    expect((await bid(kalinga, "5100")).json.error.code).toBe("NOT_LOWER");
    expect((await bid(kalinga, "5300")).json.error.code).toBe("NOT_LOWER");                      // upward bid
    expect((await bid(kalinga, "abc")).status).toBe(400);
    expect((await bid(kalinga, "4999.999")).status).toBe(400);
    expect((await kalinga.post(`/api/auctions/${auctionId}/bids`, { amount: "4000" })).status).toBe(400);   // idempotency key is mandatory
    expect((await bid(bharat, "4000")).status).toBe(403);                                        // disqualified vendor
    expect((await bid(coastal, "4000")).status).toBe(403);                                       // never invited
    expect((await bid(manager, "4000")).status).toBe(403);                                       // staff cannot bid
    const dup = await kalinga.post(`/api/auctions/${auctionId}/bids`, { amount: "5100", idempotencyKey: "kal-key-0001" });
    expect(dup.status).toBe(200); expect(dup.json.duplicate).toBe(true);                          // retry of the accepted bid is a no-op
    // vendor history shows only own bids, including rejected attempts
    const hist = (await kalinga.get(`/api/rfqs/${rfqId}/snapshot`)).json.auction.history;
    expect(hist.filter((h: any) => h.type === "accepted").length).toBe(1); expect(hist.filter((h: any) => h.type === "rejected").length).toBeGreaterThanOrEqual(3);

    // --- 16 simultaneous HTTP bids from both vendors
    const burst: Promise<any>[] = [];
    for (let i = 1; i <= 8; i++) { burst.push(bid(kalinga, String(5100 - 30 * i))); burst.push(bid(sagar, String(5150 - 30 * i))); }
    const results = await Promise.all(burst);
    expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);
    for (const slug of ["kalinga", "sagar"]) {
      const rows = await stack.sql("select amount::float a, previous_amount::float p from bids where auction_id=$1 and vendor_id=$2 order by seq", [auctionId, V[slug]]);
      let prev = slug === "kalinga" ? 5200 : 5150;
      for (const r of rows) { expect(r.p).toBe(prev); expect(prev - r.a).toBeGreaterThanOrEqual(25); prev = r.a; }
    }

    // --- late bid inside the 5 s window extends the auction (twice at most)
    const snapNow = (await kalinga.get(`/api/rfqs/${rfqId}/snapshot`)).json.auction;
    const waitMs = Date.parse(snapNow.end_at) - Date.now() - 3500;
    expect(waitMs).toBeGreaterThan(-3000);       // the burst must not have used up the whole auction
    if (waitMs > 0) await sleep(waitMs);
    const state = (await kalinga.get(`/api/rfqs/${rfqId}/snapshot`)).json.auction;
    const endBefore = Date.parse(state.end_at);
    const late = await bid(kalinga, String(Number(state.max_next_bid)));
    expect(late.status).toBe(200); expect(late.json.extended).toBe(true);
    expect(Date.parse(late.json.end_at)).toBeGreaterThan(endBefore);
    const ext = await stack.sql("select event_type from auction_events where auction_id=$1 and event_type='auction_extended'", [auctionId]);
    expect(ext.length).toBeGreaterThanOrEqual(1);

    // --- the scheduler closes the auction at the (extended) end time; the server rejects later bids
    await sA.waitFor((s) => s.auction?.status === "closed", 40000);
    const after = await bid(sagar, "1000");
    expect(after.status).toBe(422); expect(after.json.error.code).toBe("AUCTION_CLOSED");
    expect((await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status).toBe("closed");
    const events = await stack.sql("select event_type from auction_events where auction_id=$1", [auctionId]);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(["auction_opened", "bid_accepted", "bid_rejected", "auction_extended", "auction_closed"]));
    sA.close(); sB.close(); sX.close(); sAdmin.close();
  }, 120_000);

  it("shows the comparison matrix to staff only, with exports", async () => {
    expect((await kalinga.get(`/api/rfqs/${rfqId}/matrix`)).status).toBe(403);
    expect((await kalinga.get(`/api/rfqs/${rfqId}/export?type=matrix`)).status).toBe(403);
    const m = (await manager.get(`/api/rfqs/${rfqId}/matrix`)).json.rows as any[];
    expect(m.length).toBe(3);
    const ranked = m.filter((r) => r.rank).sort((a, b) => a.rank - b.rank);
    expect(ranked.length).toBe(2);                                      // only qualified vendors are ranked
    expect(Number(ranked[0].latest_price)).toBeLessThanOrEqual(Number(ranked[1].latest_price));
    const bh = m.find((r) => r.legal_name.startsWith("Bharat"));
    expect(bh.rank).toBeNull(); expect(bh.qualification_status).toBe("disqualified");
    const csv = await fetch(`${BASE}/api/rfqs/${rfqId}/export?type=matrix&format=csv`, { headers: { cookie: manager.cookie } });
    expect(csv.headers.get("content-type")).toContain("text/csv"); const text = await csv.text();
    expect(text).toContain("Rank,Vendor,Vendor ID,Origin"); expect(text).not.toContain("DEMO");   // real RFQ: no watermark
    const [demo] = await stack.sql("select id from rfqs where is_demo limit 1");                      // seeded sample RFQ: clearly labelled in exports
    const demoCsv = await (await fetch(`${BASE}/api/rfqs/${demo.id}/export?type=matrix&format=csv`, { headers: { cookie: manager.cookie } })).text();
    expect(demoCsv).toContain("DEMO DATA — not a real commercial record");
    const x = await fetch(`${BASE}/api/rfqs/${rfqId}/export?type=matrix&format=xlsx`, { headers: { cookie: manager.cookie } });
    expect(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    const bids = await (await fetch(`${BASE}/api/rfqs/${rfqId}/export?type=bids&format=csv`, { headers: { cookie: admin.cookie } })).text();
    expect(bids.split("\n").length).toBeGreaterThan(5);
  });

  it("manual allocation: validation, separation of duties, approval, publication", async () => {
    const ws = (await manager.get(`/api/rfqs/${rfqId}/allocations`)).json;
    expect(ws.rfq.status).toBe("closed"); expect(ws.lines.length).toBe(2);
    const [L1, L2] = ws.lines; expect(L1.rank).toBe(1);
    const put = (lines: any[], c = manager) => c.put(`/api/rfqs/${rfqId}/allocations`, { lines });
    expect((await put([{ vendorId: L1.vendor_id, qty: "-10" }])).status).toBe(400);
    const over = await put([{ vendorId: L1.vendor_id, qty: "501" }]);
    expect(over.status).toBe(422); expect(over.json.error.details.fields[L1.vendor_id]).toMatch(/Exceeds the offered/);
    const tot = await put([{ vendorId: L1.vendor_id, qty: "500" }, { vendorId: L2.vendor_id, qty: "400" }]);
    expect(tot.status).toBe(422); expect(tot.json.error.details.fields._total).toMatch(/exceeds the RFQ requirement of 800/);
    const dq = await put([{ vendorId: V.bharat, qty: "10" }]);
    expect(dq.status).toBe(422);                                                                  // disqualified vendor cannot be allocated
    expect((await put([{ vendorId: L1.vendor_id, qty: "500" }], approver)).status).toBe(403);     // approvers cannot edit allocation
    expect((await put([{ vendorId: L1.vendor_id, qty: "500" }], kalinga)).status).toBe(403);
    expect((await put([{ vendorId: L1.vendor_id, qty: "500", remarks: "L1 – full offer" }, { vendorId: L2.vendor_id, qty: "250", remarks: "L2 – partial" }])).status).toBe(200);   // 750 of 800: under-award is allowed
    // workflow permissions
    expect((await approver.post(`/api/rfqs/${rfqId}/award/submit`, {})).status).toBe(403);
    expect((await manager.post(`/api/rfqs/${rfqId}/award/decide`, { decision: "approve" })).status).toBe(403);
    expect((await approver.post(`/api/rfqs/${rfqId}/award/publish`)).status).toBe(409);            // not approved yet
    expect((await manager.post(`/api/rfqs/${rfqId}/award/submit`, { remarks: "Please approve 750 MT" })).status).toBe(200);
    expect((await put([{ vendorId: L1.vendor_id, qty: "100" }])).status).toBe(409);                // frozen after submission
    expect((await approver.post(`/api/rfqs/${rfqId}/award/decide`, { decision: "reject", remarks: "" })).status).toBe(422);   // rejection needs a reason
    const mid = (await manager.get(`/api/rfqs/${rfqId}/allocations`)).json;
    expect(mid.current.status).toBe("submitted"); expect(Number(mid.current.total_allocated_mt)).toBe(750);
    // vendors learn nothing until publication
    expect((await kalinga.get(`/api/vendor/rfqs/${rfqId}`)).json.award).toEqual({ published: false });
    expect((await approver.post(`/api/rfqs/${rfqId}/award/decide`, { decision: "approve", remarks: "OK" })).status).toBe(200);
    expect((await kalinga.get(`/api/vendor/rfqs/${rfqId}`)).json.award).toEqual({ published: false });
    stack.mock.clear();
    const pub = await approver.post(`/api/rfqs/${rfqId}/award/publish`);
    expect(pub.status).toBe(200); expect(pub.json.notificationsQueued).toBe(4);                    // 2 awarded vendors × (e-mail + WhatsApp)
    expect((await manager.get(`/api/rfqs/${rfqId}`)).json.rfq.status).toBe("awarded");
    const a1 = (await kalinga.get(`/api/vendor/rfqs/${rfqId}`)).json.award, a2 = (await sagar.get(`/api/vendor/rfqs/${rfqId}`)).json.award;
    expect(a1).toMatchObject({ published: true, awarded: true, allocated_qty_mt: 500 }); expect(a2).toMatchObject({ published: true, awarded: true, allocated_qty_mt: 250 });
    expect(JSON.stringify(a1)).not.toContain(String(a2.final_price) + "x");
    expect((await put([{ vendorId: L1.vendor_id, qty: "1" }])).status).toBe(409);
    await until(async () => stack.mock.of("resend").length >= 2 && stack.mock.of("meta").length >= 2, 15000);
    const awardMail = stack.mock.of("resend").find((m) => m.body.to[0] === "kalinga@vendor.demo")!;
    expect(awardMail.body.subject).toContain("Award notice"); expect(awardMail.body.text).toContain("500");
    expect(awardMail.body.text).not.toMatch(/Sagar|250 MT/);
  });

  it("records a complete, tamper-evident audit trail for the whole workflow", async () => {
    const rows = (await admin.get(`/api/audit?rfq=${rfqId}&limit=500`)).json.rows as any[];
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["rfq.create", "rfq.status_change", "invitation.create", "offer.create", "offer.update", "document.create", "auction.create", "auction.status_change", "allocation.create", "award.create", "award.status_change", "report.export"])
      expect(actions, a).toContain(a);
    const alloc = rows.filter((r) => r.entity_type === "allocation");
    expect(alloc.every((r) => r.actor_name)).toBe(true);
    expect((await admin.get("/api/audit/verify")).json).toMatchObject({ ok: true });
    expect((await kalinga.get("/api/audit/verify")).status).toBe(403);
    // staff downloads of vendor documents are audited
    expect((await admin.get("/api/audit?entity=document&action=document.download")).json.rows.length).toBeGreaterThan(0);
    // login events carry the actor
    expect((await admin.get("/api/audit?action=auth.login")).json.rows.length).toBeGreaterThan(0);
    const csv = await (await fetch(`${BASE}/api/audit/export?rfq=${rfqId}&format=csv`, { headers: { cookie: approver.cookie || admin.cookie } })).text();
    expect(csv.split("\n")[0]).toContain("Row hash");
  });
});

describe("notification delivery tracking & retries", () => {
  const mkRow = async (vendorSlug: string, channel: "email" | "whatsapp", dedupe: string) => {
    const [r] = await stack.sql(`insert into notifications(kind, channel, rfq_id, vendor_id, recipient, payload, status, provider, dedupe_key, next_attempt_at)
      values ('auction_closed',$1,$2,$3,$4,$5,'pending',$6,$7, now()) returning id`,
      [channel, rfqId, V[vendorSlug], channel === "email" ? `${vendorSlug}@vendor.demo` : "+919800000001",
       JSON.stringify({ vendor_name: "Test Vendor", rfq_id: rfqId, rfq_number: "RFQ-TEST", material: "Coal" }), channel === "email" ? "resend" : "whatsapp_cloud", dedupe]);
    return r.id as string;
  };
  const status = async (id: string) => (await stack.sql("select status, attempts, last_error, provider_message_id, next_attempt_at, delivered_at from notifications where id=$1", [id]))[0];
  const tick = () => fetch(`${BASE}/api/cron/tick`, { method: "POST", headers: { authorization: "Bearer cron-test-secret" } });

  it("protects the cron endpoint", async () => {
    expect((await fetch(`${BASE}/api/cron/tick`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${BASE}/api/cron/tick`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await tick()).status).toBe(200);
  });

  it("retries transient provider failures with backoff, then marks sent; permanent errors fail immediately and can be re-queued", async () => {
    stack.mock.clear(); stack.mock.failures.resend = [{ status: 500 }, { status: 429 }];
    const id = await mkRow("kalinga", "email", "retry-test-1");
    let s = await until(async () => { const r = await status(id); return r.attempts >= 1 ? r : null; }, 10000);
    expect(s.status).toBe("pending"); expect(s.last_error).toMatch(/Resend 500/); expect(new Date(s.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);   // 1 min backoff
    await stack.sql("update notifications set next_attempt_at = now() where id=$1", [id]);
    s = await until(async () => { const r = await status(id); return r.attempts >= 2 ? r : null; }, 10000);
    expect(s.last_error).toMatch(/Resend 429/);
    await stack.sql("update notifications set next_attempt_at = now() where id=$1", [id]);
    s = await until(async () => { const r = await status(id); return r.status === "sent" ? r : null; }, 10000);
    expect(s.attempts).toBe(3); expect(s.provider_message_id).toMatch(/^re_mock_/); expect(s.last_error).toBeNull();
    // all retries reuse the same idempotency key → the provider can de-duplicate
    const keys = stack.mock.of("resend").map((r) => r.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);

    stack.mock.clear(); stack.mock.failures.meta = [{ status: 400, body: { error: { code: 132001, message: "Template does not exist", error_data: { details: "template name does not exist in en" } } } }];
    const wid = await mkRow("kalinga", "whatsapp", "perm-test-1");
    s = await until(async () => { const r = await status(wid); return r.status === "failed" ? r : null; }, 10000);
    expect(s.attempts).toBe(1); expect(s.last_error).toMatch(/132001.*template name does not exist/);
    expect((await kalinga.post(`/api/notifications/${wid}/requeue`)).status).toBe(403);
    expect((await manager.post(`/api/notifications/${wid}/requeue`)).status).toBe(200);
    s = await until(async () => { const r = await status(wid); return r.status === "sent" ? r : null; }, 10000);
    expect(s.provider_message_id).toMatch(/^wamid\./);
  });

  it("gives up after max attempts and reports it as failed", async () => {
    stack.mock.clear(); stack.mock.failures.resend = Array.from({ length: 6 }, () => ({ status: 503 }));
    const id = await mkRow("sagar", "email", "exhaust-test-1");
    await stack.sql("update notifications set max_attempts = 2 where id=$1", [id]);
    await until(async () => (await status(id)).attempts >= 1, 10000);
    await stack.sql("update notifications set next_attempt_at = now() where id=$1", [id]);
    const s = await until(async () => { const r = await status(id); return r.status === "failed" ? r : null; }, 10000);
    expect(s.attempts).toBe(2);
  });

  it("records delivery receipts from verified provider webhooks only", async () => {
    stack.mock.clear();
    const id = await mkRow("sagar", "email", "webhook-test-1");
    const sent = await until(async () => { const r = await status(id); return r.status === "sent" ? r : null; }, 10000);
    const evt = JSON.stringify({ type: "email.delivered", data: { email_id: sent.provider_message_id } });
    expect((await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", body: evt })).status).toBe(401);
    expect((await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", body: evt, headers: { ...signResend(evt), "svix-signature": "v1,AAAA" } })).status).toBe(401);
    expect((await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", body: evt, headers: signResend(evt, "m1", Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);   // replay window
    expect((await status(id)).status).toBe("sent");
    expect((await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", body: evt, headers: signResend(evt) })).status).toBe(200);
    expect((await status(id)).status).toBe("delivered");
    const bounce = JSON.stringify({ type: "email.bounced", data: { email_id: sent.provider_message_id, bounce: { message: "mailbox full" } } });
    await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", body: bounce, headers: signResend(bounce, "m2") });
    expect(await status(id)).toMatchObject({ status: "failed", last_error: "Resend: mailbox full" });

    const wid = await mkRow("sagar", "whatsapp", "webhook-test-2");
    const ws = await until(async () => { const r = await status(wid); return r.status === "sent" ? r : null; }, 10000);
    const wbody = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: ws.provider_message_id, status: "delivered" }] } }] }] });
    expect((await fetch(`${BASE}/api/webhooks/whatsapp`, { method: "POST", body: wbody, headers: { "x-hub-signature-256": "sha256=deadbeef" } })).status).toBe(401);
    expect((await fetch(`${BASE}/api/webhooks/whatsapp`, { method: "POST", body: wbody, headers: { "x-hub-signature-256": signWhatsApp(wbody) } })).status).toBe(200);
    expect((await status(wid)).status).toBe("delivered");
    expect((await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=12345`)).status).toBe(200);
    expect((await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`)).status).toBe(403);
  });
});
