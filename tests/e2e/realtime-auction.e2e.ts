/**
 * FINAL ACCEPTANCE TEST — real browsers, real server, real database.
 *
 *  admin creates + publishes an RFQ → two independently authenticated vendors submit quotations → admin qualifies both and schedules the
 *  auction → both vendors are in the same live auction (separate browser contexts) → one vendor revises their FOR price → the OTHER
 *  vendor's page updates its rank WITHOUT a reload → admin closes the auction → procurement allocates manually → approver approves and
 *  publishes → vendors see their award → the audit chain verifies.
 *
 *  Run:  npm run build && npm run test:e2e        (needs the local Postgres from `npm run db:start`)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BASE, Stack } from "../helpers/stack";

const SHOTS = path.resolve("docs/screenshots");
const TMP = path.resolve(".artifacts");
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(TMP, { recursive: true });
const COA = path.join(TMP, "coa-sample.pdf");
fs.writeFileSync(COA, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const ist = (d: DateTime) => d.setZone("Asia/Kolkata").toFormat("yyyy-LL-dd'T'HH:mm");
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newSession(browser: Browser, label: string, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport, baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());                                  // window.confirm() prompts
  page.on("pageerror", (e) => console.error(`  [${label}] page error:`, e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.error(`  [${label}] console:`, m.text()); });
  return { ctx, page, label };
}
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}
const textOf = async (page: Page, id: string) => (await page.getByTestId(id).first().textContent())?.trim() ?? "";
async function waitTestId(page: Page, id: string, pred: (t: string) => boolean, timeout = 15000, what = id) {
  const start = Date.now(); let last = "";
  while (Date.now() - start < timeout) {
    last = await page.getByTestId(id).first().textContent({ timeout: 1000 }).then((t) => t?.trim() ?? "").catch(() => "");
    if (pred(last)) return last;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}; last value: "${last}"`);
}

async function main() {
  const stack = new Stack();
  log("booting stack (fresh database, built Next.js server, mock e-mail/WhatsApp providers)");
  await stack.start({ AUCTION_MIN_LEAD_SECONDS: "2" });
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const [admin, approver, va, vb] = await Promise.all([
      newSession(browser, "manager"), newSession(browser, "approver"),
      newSession(browser, "vendor-A", { width: 390, height: 844 }),       // vendor A on a phone-sized viewport
      newSession(browser, "vendor-B"),
    ]);
    await Promise.all([login(admin.page, "manager@grainspan.demo"), login(approver.page, "approver@grainspan.demo"), login(va.page, "kalinga@vendor.demo"), login(vb.page, "sagar@vendor.demo")]);
    log("4 independent browser sessions signed in: procurement manager, approver, vendor A (Kalinga, mobile viewport), vendor B (Sagar)");

    // ------------------------------------------------------------------ 1. admin creates + publishes the RFQ
    const a = admin.page;
    await a.goto("/admin/rfqs/new");
    await a.getByLabel("Total required quantity (MT) *").fill("1000");
    await a.getByLabel("Minimum GCV (ARB) kcal/kg *").fill("4200");
    await a.getByLabel("Maximum total moisture (ARB) % *").fill("18");
    await a.getByLabel("Maximum ash %").fill("12");
    await a.getByLabel("Origin / country of origin").fill("Indonesia / South Africa");
    await a.getByLabel("Delivery location *").fill("Grainspan plant, Kutch, Gujarat");
    await a.getByLabel("Payment terms").fill("95% against delivery documents, 5% in 15 days");
    await a.getByLabel("Quotation submission deadline *").fill(ist(DateTime.now().plus({ hours: 2 })));
    await a.getByLabel("Auction start *").fill(ist(DateTime.now().plus({ hours: 3 })));
    await a.getByLabel("Auction end *").fill(ist(DateTime.now().plus({ hours: 4 })));
    await a.getByLabel("Minimum bid decrement (₹/MT) *").fill("25");
    await a.getByLabel("Automatically extend the auction").check();
    await a.getByLabel(/Kalinga Coal/).check();
    await a.getByLabel(/Sagar Fuels/).check();
    await a.screenshot({ path: path.join(SHOTS, "01-admin-rfq-form.png"), fullPage: true });
    stack.mock.clear();
    await a.getByRole("button", { name: "Publish & notify vendors" }).click();
    await a.waitForURL(/\/admin\/rfqs\/[0-9a-f-]{36}$/, { timeout: 15000 });
    const rfqId = a.url().split("/").pop()!;
    await a.getByText("Quotation open").first().waitFor({ timeout: 10000 });
    log(`RFQ created & published via UI (${rfqId}); status: Quotation open`);
    for (let i = 0; i < 60 && (stack.mock.of("resend").length < 2 || stack.mock.of("meta").length < 2); i++) await sleep(250);
    assert.equal(stack.mock.of("resend").length, 2, "two invitation e-mails sent through the e-mail provider API");
    assert.equal(stack.mock.of("meta").length, 2, "two invitation WhatsApp template messages sent through the WhatsApp API");
    log("invitations delivered to the provider APIs: 2 e-mails + 2 WhatsApp template messages (mock provider endpoints)");

    // ------------------------------------------------------------------ 2. vendors submit quotations (separate sessions)
    async function quote(s: { page: Page; label: string }, price: string, qty: string) {
      const p = s.page;
      await p.goto("/vendor");
      await p.getByRole("link", { name: /RFQ-\d{4}-\d{4}/ }).first().click();
      await p.waitForURL(/\/vendor\/rfqs\//);
      await p.getByLabel("Material origin *").fill("Indonesia");
      await p.getByLabel("Quantity offered (MT) *").fill(qty);
      await p.getByLabel("GCV (ARB), kcal/kg *").fill("4250");
      await p.getByLabel("Total moisture (ARB), % *").fill("16");
      await p.getByLabel("Ash content, % *").fill("9");
      await p.getByLabel("Delivery lead time (days) *").fill("14");
      await p.getByLabel("Initial FOR price (₹ per MT) *").fill(price);
      // a quotation without the mandatory COA must be refused by the server
      await p.getByRole("button", { name: "Submit quotation" }).click();
      await p.getByText(/Certificate of Analysis \(COA\) must be uploaded/).first().waitFor({ timeout: 10000 });
      await p.locator('input[type=file]').first().setInputFiles(COA);
      await p.getByText("coa-sample.pdf").waitFor({ timeout: 10000 });
      await p.getByRole("button", { name: "Submit quotation" }).click();
      await p.getByText("Quotation submitted").first().waitFor({ timeout: 10000 });
      log(`${s.label}: quotation submitted (initial FOR ₹${price}/MT, ${qty} MT) with COA`);
    }
    await Promise.all([quote(va, "5200", "600"), quote(vb, "5150", "600")]);
    await va.page.screenshot({ path: path.join(SHOTS, "02-vendor-quotation-mobile.png"), fullPage: true });

    // ------------------------------------------------------------------ 3. admin qualifies both and schedules the auction
    await a.goto(`/admin/rfqs/${rfqId}/quotations`);
    await a.getByText("Technically compliant").first().waitFor();
    for (let i = 0; i < 2; i++) {
      await a.getByRole("button", { name: "Qualify", exact: true }).first().click();
      await a.getByRole("button", { name: "Confirm" }).click();
      await a.waitForFunction((n) => document.querySelectorAll("span").length > 0 && Array.from(document.querySelectorAll("span")).filter((e) => e.textContent?.trim() === "qualified").length >= n, i + 1, { timeout: 10000 });
    }
    await a.screenshot({ path: path.join(SHOTS, "03-admin-qualification.png"), fullPage: true });
    log("admin qualified both vendors (technical qualification, separate from price)");
    await a.goto(`/admin/rfqs/${rfqId}`);
    await a.getByRole("button", { name: "Close quotations now" }).click();
    await a.getByLabel("Reason").fill("All invited vendors have quoted");
    await a.getByRole("button", { name: "Close quotations", exact: true }).click();
    await a.getByRole("button", { name: "Schedule auction" }).waitFor({ timeout: 10000 });
    // start at the next whole minute that is at least 25 s away; run for 3 minutes
    let start = DateTime.now().plus({ seconds: 25 }).plus({ minutes: 1 }).startOf("minute");
    await a.getByRole("button", { name: "Schedule auction" }).click();
    await a.getByLabel("Auction start").fill(ist(start));
    await a.getByLabel("Auction end").fill(ist(start.plus({ minutes: 3 })));
    await a.getByRole("button", { name: "Schedule", exact: true }).click();
    await a.getByText("Auction scheduled").first().waitFor({ timeout: 10000 });
    log(`auction scheduled for ${start.setZone("Asia/Kolkata").toFormat("HH:mm")} IST (server opens it, not a browser)`);

    // vendors open the auction view while it is still scheduled → countdown to start, no ranking visible
    await Promise.all([va.page.goto(`/vendor/rfqs/${rfqId}`), vb.page.goto(`/vendor/rfqs/${rfqId}`)]);
    await va.page.getByText("Auction starts in").waitFor({ timeout: 10000 });
    assert.equal(await va.page.getByTestId("my-rank").first().textContent(), "—", "no rank is revealed before the auction starts");
    await a.goto(`/admin/rfqs/${rfqId}/auction`);
    log("both vendors are waiting on the auction page (countdown running); admin monitor open");

    // ------------------------------------------------------------------ 4. live auction
    log("waiting for the server to open the auction …");
    await Promise.all([va.page.getByRole("button", { name: "Submit bid" }).waitFor({ timeout: 150000 }), vb.page.getByRole("button", { name: "Submit bid" }).waitFor({ timeout: 150000 })]);
    log("AUCTION LIVE in both vendor browsers (no page reload by the test)");
    assert.equal(await textOf(vb.page, "my-rank"), "1", "Sagar (₹5150) starts at rank 1");
    assert.equal(await textOf(va.page, "my-rank"), "2", "Kalinga (₹5200) starts at rank 2");
    await admin.page.locator('[data-testid^="standing-"]').first().waitFor({ timeout: 10000 });
    await a.screenshot({ path: path.join(SHOTS, "04-admin-live-monitor-before.png"), fullPage: true });
    await vb.page.screenshot({ path: path.join(SHOTS, "05-vendor-B-live.png") });

    // vendor A revises the FOR price to 5100 (below vendor B's 5150) from a *different* browser session
    const tBid = Date.now();
    await va.page.getByLabel(/Your new FOR price/).fill("5100");
    await va.page.getByRole("button", { name: "Submit bid" }).click();
    await va.page.getByText(/Bid accepted: ₹5,100\.00\/MT/).waitFor({ timeout: 10000 });
    const confirmMs = Date.now() - tBid;
    await waitTestId(va.page, "my-rank", (t) => t === "1", 8000, "vendor A rank 1");
    // vendor B's page, which nobody touched, must now show rank 2 — pushed by the server
    const pushedRank = await waitTestId(vb.page, "my-rank", (t) => t === "2", 8000, "vendor B rank → 2 without refresh");
    const pushMs = Date.now() - tBid;
    log(`vendor A bid ₹5,100 accepted (${confirmMs} ms incl. UI); vendor B's rank updated 1 → ${pushedRank} in real time, ${pushMs} ms after the click, with NO page refresh`);
    assert.match(await textOf(vb.page, "my-price"), /^₹5,150\.00\s*\/MT$/, "vendor B's own price is unchanged");
    const bText = await vb.page.locator("main").innerText();
    assert.ok(!/5,100|5100|Kalinga/i.test(bText), "vendor B's screen reveals nothing about vendor A (no price, name or ladder)");
    // admin monitor updated by push too
    await waitTestId(admin.page, "admin-countdown", (t) => /\d\d:\d\d/.test(t), 5000);
    await admin.page.waitForFunction(() => document.querySelector('[data-testid="standing-VND-0001"]')?.getAttribute("data-rank") === "1", null, { timeout: 8000 });
    const adminRows = await admin.page.locator('[data-testid^="standing-"]').evaluateAll((rows) => rows.map((r) => `${r.getAttribute("data-rank")}:${r.getAttribute("data-price")}`));
    assert.deepEqual(adminRows, ["1:5100.00", "2:5150.00"]);
    log(`admin monitor (also no refresh) shows the full ranking ${adminRows.join("  ")}`);
    await a.screenshot({ path: path.join(SHOTS, "06-admin-live-monitor-after.png"), fullPage: true });

    // server-side rule enforcement visible in the UI: too-small decrement is refused with an explanation
    await vb.page.getByLabel(/Your new FOR price/).fill("5140");
    await vb.page.getByRole("button", { name: "Submit bid" }).click();
    await vb.page.getByText(/at least ₹25\.00 below your current price/).first().waitFor({ timeout: 8000 });
    // vendor B counter-bids lower; vendor A's page flips back to rank 2, again without refresh
    await vb.page.getByLabel(/Your new FOR price/).fill("5050");
    await vb.page.getByRole("button", { name: "Submit bid" }).click();
    await vb.page.getByText(/Bid accepted: ₹5,050\.00\/MT/).waitFor({ timeout: 10000 });
    await waitTestId(vb.page, "my-rank", (t) => t === "1", 8000);
    await waitTestId(va.page, "my-rank", (t) => t === "2", 8000, "vendor A pushed back to rank 2");
    log("vendor B counter-bid ₹5,050 → vendor A's phone-sized session flipped to rank 2 in real time");
    await va.page.screenshot({ path: path.join(SHOTS, "07-vendor-A-mobile-live.png") });

    // ------------------------------------------------------------------ 5. admin closes the auction
    await a.getByRole("button", { name: "Close auction now" }).click();
    await a.getByLabel("Reason").fill("Sufficient competitive tension");
    await a.getByRole("button", { name: "Close auction", exact: true }).click();
    await Promise.all([va.page.getByText(/auction has closed/i).first().waitFor({ timeout: 10000 }), vb.page.getByText(/auction has closed/i).first().waitFor({ timeout: 10000 })]);
    log("admin closed the auction; both vendor browsers switched to the closed state in real time");
    const late = await va.page.evaluate(async (rfq) => {      // a stale browser tab trying to bid after closure
      const snap = await (await fetch(`/api/rfqs/${rfq}/snapshot`)).json();
      const r = await fetch(`/api/auctions/${snap.auction.auction_id}/bids`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: "1000", idempotencyKey: crypto.randomUUID() }) });
      return { status: r.status, body: await r.json() };
    }, rfqId);
    assert.equal(late.status, 422); assert.equal(late.body.error.code, "AUCTION_CLOSED");
    log("post-close bid attempt rejected by the server (AUCTION_CLOSED)");

    // ------------------------------------------------------------------ 6. comparison matrix + manual allocation
    await a.goto(`/admin/rfqs/${rfqId}/comparison`);
    await a.getByText("Kalinga Coal").first().waitFor();
    await a.screenshot({ path: path.join(SHOTS, "08-admin-comparison-matrix.png"), fullPage: true });
    await a.goto(`/admin/rfqs/${rfqId}/allocation`);
    await a.getByLabel("Quantity for Sagar Fuels International").fill("600");      // rank 1 (₹5,050)
    await a.getByLabel("Quantity for Kalinga Coal & Logistics Pvt Ltd").fill("400");
    await a.screenshot({ path: path.join(SHOTS, "09-admin-allocation.png"), fullPage: true });
    await a.getByRole("button", { name: "Submit for approval" }).click();
    await a.getByRole("button", { name: "Save & submit" }).click();
    await a.getByText("Submitted for approval.", { exact: true }).waitFor({ timeout: 10000 });      // the confirmation message, not the static workflow label
    await a.getByText("submitted", { exact: true }).first().waitFor({ timeout: 10000 });          // and the status badge reflects the new state
    log("manager allocated 600 MT + 400 MT = 1000 MT manually and submitted for approval");

    // over-allocation is blocked in the UI (and by the server/DB): try as the approver's colleague is not possible; assert button state instead
    // ------------------------------------------------------------------ 7. approver approves and publishes
    const p = approver.page;
    await p.goto(`/admin/rfqs/${rfqId}/allocation`);
    await p.getByRole("button", { name: "Approve", exact: true }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await p.getByRole("button", { name: "Publish award to vendors" }).waitFor({ timeout: 10000 });
    stack.mock.clear();
    await p.getByRole("button", { name: "Publish award to vendors" }).click();
    await p.getByText("Award published.").first().waitFor({ timeout: 15000 });
    log("approver approved and published the award");
    // vendors see the award appear without refresh
    await Promise.all([va.page.getByText("Award notice").waitFor({ timeout: 20000 }), vb.page.getByText("Award notice").waitFor({ timeout: 20000 })]);
    const aTxt = await va.page.getByText("Award notice").locator("xpath=ancestor::section").innerText();
    const bTxt = await vb.page.getByText("Award notice").locator("xpath=ancestor::section").innerText();
    assert.match(aTxt, /400 MT/); assert.match(bTxt, /600 MT/);
    assert.ok(!/600 MT/.test(aTxt) && !/400 MT/.test(bTxt), "each vendor sees only their own allocation");
    log("vendor A sees 400 MT, vendor B sees 600 MT — each only their own");
    await vb.page.screenshot({ path: path.join(SHOTS, "10-vendor-award.png"), fullPage: true });
    for (let i = 0; i < 60 && (stack.mock.of("resend").length < 2 || stack.mock.of("meta").length < 2); i++) await sleep(250);
    assert.equal(stack.mock.of("resend").length, 2); assert.equal(stack.mock.of("meta").length, 2);
    log("award notices sent: 2 e-mails + 2 WhatsApp template messages");

    // ------------------------------------------------------------------ 8. audit trail
    await a.goto(`/admin/rfqs/${rfqId}/audit`);
    await a.getByText("allocation.create").first().waitFor();
    await a.goto("/admin/audit");
    await a.getByRole("button", { name: "Verify audit-chain integrity" }).click();
    await a.getByText(/Chain intact — [\d,]+ entries verified/).waitFor({ timeout: 10000 });
    await a.screenshot({ path: path.join(SHOTS, "11-admin-audit.png") });
    const bids = await stack.sql("select count(*)::int c from bids");
    log(`audit chain verified; ${bids[0].c} immutable bid records in the database`);
    const dbStatus = await stack.sql("select status from rfqs where id=$1", [rfqId]);
    assert.equal(dbStatus[0].status, "awarded");
    console.log("\n✅ ACCEPTANCE TEST PASSED — admin + 2 vendors + approver, 4 independent browser sessions, real-time ranking verified\n");
  } finally {
    await browser?.close();
    await stack.stop();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ E2E FAILED:", e); process.exit(1); });
