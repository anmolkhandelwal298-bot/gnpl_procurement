# Test report

Run on **2026-10-28**, PostgreSQL 16.15, Node 22.22, Next.js 16.4.3, Chromium 1243 (Playwright 1.63). Everything below ran against a **real database and the real built server** — no database mocking.

| Suite | Command | Result |
|---|---|---|
| Type-check (app + tests) | `npm run typecheck` | ✅ clean |
| Database tests | `npm test` | ✅ **50 / 50** (≈ 6 s) |
| HTTP tests (fresh DB + real server + mock providers) | `npm run build && npm run test:api` | ✅ **26 / 26** (≈ 60 s) |
| Browser acceptance test (4 browser contexts) | `npm run test:e2e` | ✅ passed on 2 consecutive final runs after the last change (plus earlier passes) |

## The acceptance scenario (browser test)

`tests/e2e/realtime-auction.e2e.ts` drives the real UI in **four independent Chromium contexts** (separate cookies/sessions): procurement manager, approver, vendor A (phone-sized viewport) and vendor B.

1. Manager creates an RFQ through the form and publishes it → 2 invitation e-mails + 2 WhatsApp template messages reach the (mock) provider APIs.
2. Each vendor submits a quotation; the first attempt **without COA is refused by the server**, then accepted with a COA.
3. Manager qualifies both, closes quotations, schedules the auction. Vendors wait on the page with a running countdown and **no rank visible**.
4. The **server** opens the auction; both vendor pages switch to bidding without a reload.
5. **Vendor A bids ₹5,100 → Vendor B's untouched browser changes rank 1 → 2 in ≈ 0.23–0.27 s with no refresh** (measured: 250 ms and 234 ms in the final runs; 238–266 ms in earlier runs); the admin monitor updates too, and Vendor B's page is checked to contain no trace of Vendor A's price or name.
6. A too-small decrement is refused with an explanation; Vendor B counter-bids and Vendor A's phone session flips back to rank 2.
7. Manager closes the auction; both vendor pages switch to *closed*; a bid from a stale tab is rejected by the server (`AUCTION_CLOSED`).
8. Manager allocates 600 + 400 = 1000 MT manually and submits; the approver approves and publishes; vendors see **only their own** allocation appear live; award notices go out (2 e-mails + 2 WhatsApp).
9. The audit log shows the allocation entries and **"Verify audit-chain integrity" reports the chain intact**.

Screenshots from this run are in `docs/screenshots/`.

## Database tests (`tests/db`, 50)

Run as the **restricted `grainspan_app` role** with per-transaction user context, exactly as the server does.

* **`auction.test.ts` (15)** — decrement against the vendor's *own* price; upward/equal/zero/negative/3-decimal rejection; closed and not-yet-started auctions; ineligible callers (other RFQ, unqualified, staff, admin, unknown auction, suspended vendor); idempotent retries; **40 simultaneous bids** (chain consistency, no lost update, unique gap-free ranks); same-price race (exactly one winner); ranking and tie-break; extension on/off, window and maximum; append-only enforcement even for the owner; no write privilege on `bids`.
* **`security.test.ts` (10)** — row isolation across vendors, RFQs, profiles; vendors cannot read bids/auctions/events/allocations/awards/notifications/audit/credentials/sessions; fail-closed with no context or a ghost user; vendors cannot edit others' data, qualify themselves, promote themselves, approve themselves, or call internal/admin functions; the vendor auction state contains only own figures; uninvited and pending vendors see nothing; approver/manager boundaries; only admins create staff.
* **`offers-rfq.test.ts` (12)** — strict vs review compliance, incomplete submissions, COA requirement, deadline lock, lock after scheduling with formal reopen + one-time per-vendor revision, staff cannot edit vendor data; RFQ state machine, specification freeze, invitation rules, draft invisibility, decline rules.
* **`awards-audit.test.ts` (13)** — allocation validation (negative, over-offered, over-requirement with deferred check, unqualified, wrong role/state, under-award allowed); submit → approve → publish with frozen snapshot and exact totals; separation of duties even for admins; rejection requires a reason and opens a new cycle; empty allocation refused; vendors see award only after publication and only their own line; audit completeness, no secrets in audit rows, **tamper detection** (modified row, removed newest row, removed middle row) and forging attempts.

## HTTP tests (`tests/api`, 26)

* **`workflow.test.ts` (20)** — unauthenticated access, cookie flags and security headers, role boundaries on every portal, CSRF/Origin checks, generic login failure + lockout + audit, server-side session revocation, vendor registration → approval; then the whole procurement flow over HTTP: RFQ validation, publication with **real provider-API calls** (checked: recipients, auth header, idempotency key, template name/params, no other vendor's name in any message), vendor isolation, quotation validation (incomplete, non-compliant, spoofed/oversized files, filename sanitising), document isolation, qualification gating, specification lock, **real-time auction over SSE** (server-side opening; competitor's stream receives the rank change within ≈ 0.2 s; snapshot contains no competitor data; rejections; idempotent retry; 16 concurrent HTTP bids; late-bid extension; scheduler closes at the extended end; post-close bid rejected), matrix + CSV/Excel + demo watermark, allocation/approval/publication with permission and separation-of-duty checks, audit completeness and chain verification, notification retries with backoff, permanent-failure and re-queue flow, retry exhaustion, delivery webhooks (valid, forged, replayed, bounced).
* **`scheduler-security.test.ts` (6)** — reminder windows (once per window, only unsubmitted vendors, not for windows already open at publication); deadline → qualification, auction open / closing reminder / close driven by the server clock alone; idle and absolute session expiry; immediate effect of deactivation and suspension; forced password change; login rate limiting.

## What these tests do **not** prove

* **Real e-mail / WhatsApp delivery.** Provider calls were verified against local mock servers only (request shape, headers, retries, webhooks). Real accounts, domain verification, template approval and webhook configuration are untested — follow docs/NOTIFICATIONS.md.
* **Public deployment, TLS, HTTP/2, proxy buffering of SSE, Docker image build, Supabase.** None of these were available in the build environment. Only the Next.js standalone server and a local PostgreSQL were exercised.
* **Other browsers / devices.** Only Chromium (desktop viewport and a 390×844 phone viewport) was used.
* **Scale.** Concurrency was tested with up to 40 simultaneous bids on one auction and a handful of simultaneous viewers; no load test with hundreds of vendors was run. SSE fan-out re-reads one snapshot per open page per change, which is fine for tens of vendors; benchmark before running very large auctions.
* **Security beyond the listed controls** — no third-party penetration test; no MFA; no malware scanning of uploads (docs/SECURITY.md).
* **Time zones/DST** — IST has no DST; other zones are formatted with `Intl` but not tested.

## How to reproduce

```bash
npm install && npm run db:start && npm run typecheck
npm test                       # database tests (creates/drops grainspan_test)
npm run build && npm run test:api
npm run test:e2e               # needs the built app; boots its own database "grainspan_api" on ports 3100/4010
```
The suites assume the local PostgreSQL started by `npm run db:start` (port 54329, trust auth). Set `E2E_PORT`, `E2E_MOCK_PORT`, `E2E_DB` to change test ports/database.

## Defects found by these tests during development

Listed because they show what the tests are for (all fixed): `INCOMPLETE` check treated field names as array literals; award publication could not flip the RFQ to *awarded* for an approver (now atomic in the DB); wrong-password login returned HTTP 500 (SQL parameter typing); publishing an RFQ returned 500 (same class, in the notification outbox); deadline reminders fired at publication for short deadlines (3 messages at once); a missing Origin override in the test client; the vendor bid form could appear before the server's rank data (UI trusted the browser clock); vendor and admin pages did not update on award publication or RFQ stage changes until reload (no realtime notification) — now a status trigger; Zod rejected omitted optional keys.
