# Security model

Each control lists **where it is enforced** and **the test that demonstrates it** (files under `tests/`). "DB" = `tests/db/*` (real PostgreSQL), "API" = `tests/api/*` (real server over HTTP), "E2E" = `tests/e2e/realtime-auction.e2e.ts` (real browsers).

## Controls

| Requirement | How it is enforced | Evidence |
|---|---|---|
| Role-based access (admin, procurement manager, approver, vendor) | Role checked in the API wrapper **and** in the database (`app_role()` in RLS policies and triggers) | API: "enforces role boundaries on every portal"; DB: "staff role boundaries" |
| Database-level row security | RLS enabled on every table; runtime role `grainspan_app` is not superuser and has no `BYPASSRLS`; per-transaction `app.user_id`/`app.mode`; no context ⇒ no rows | DB: "a vendor sees only their own rows…", "fail-closed" |
| Vendors only see invited RFQs | `rfqs` policy requires an invitation; drafts invisible | DB + API ("vendors see only RFQs they were invited to…") |
| Vendors cannot see other vendors' names/prices/bids/contacts/documents | no vendor policy on `bids`, `auctions`, `auction_events`, `allocations`, `award_approvals`, `notifications`, `audit_logs`; reads go through 3 narrow `SECURITY DEFINER` functions; documents RLS-scoped | DB: "vendors cannot read bids…", "vendor_auction_state exposes ONLY…"; API: stream snapshot key whitelist + no-leak assertions; E2E: competitor's screen text checked |
| Vendors cannot manipulate ranks/prices/roles | rank is computed in SQL, never accepted from clients; vendor writes limited by guard triggers (cannot change qualification, role, status…) | DB: "vendors cannot modify another vendor's quotation… cannot touch staff-controlled columns" |
| Never trust browser-supplied vendor id / price / role | vendor identity derived from the session in `app_approved_vendor_id()`; bid function takes only auction id, amount and idempotency key | DB: place_bid eligibility tests |
| Server-authoritative auction clock | `clock_timestamp()` inside `place_bid()` after the row lock | DB: "rejects bids after the auction closes (server clock)…"; API: scheduler-lag case |
| Atomic bids, no lost updates | `SELECT … FOR UPDATE` on the auction row | DB: 40 concurrent bids; API: 16 concurrent HTTP bids |
| Duplicate-submission protection | per-(auction, vendor) idempotency key, unique index | DB + API |
| Immutable bids / auction events / audit | triggers reject UPDATE/DELETE/TRUNCATE for everyone; app role has no write privilege on `bids`/`audit_logs` | DB: "append-only data" |
| Audit trail of critical actions | row-change triggers on 9 business tables + explicit entries (login, export, document download); actor taken from DB context; **SHA-256 hash chain** with `verify_audit_chain()` | DB: "audit trail" (tamper + deletion detection); API: audit completeness; E2E: chain verified from the UI |
| Server-side input validation | Zod schemas on every endpoint + DB constraints/triggers as backstop | API: validation tests |
| CSRF | `SameSite=Lax` cookie + mandatory same-origin `Origin` header on state-changing requests | API: "blocks cross-origin and origin-less…" |
| Session security | random 256-bit token, only its HMAC stored; `HttpOnly`, `SameSite=Lax`, `Secure` in production; 60-min idle + 12-h absolute timeout (configurable); revoked on logout, password change/reset, user deactivation | API: logout/idle/absolute/deactivation tests |
| Credential stealing resistance | scrypt (N=32768) password hashes in a table unreachable in normal user mode; per-account lockout (5 failures → 15 min); per-IP and per-account login rate limits; generic error messages (no account enumeration) | API: login tests |
| Rate limiting / abuse | in-memory sliding windows on login, registration, bids (30/min/user), uploads, exports, etc. | API: rate-limit test |
| Secure file upload & private storage | ≤ 10 MB, type allow-list verified by **magic bytes** (not extension/MIME), names sanitised, SHA-256 recorded, stored in a private DB table, served only through an authenticated route as `attachment` + `nosniff` + sandbox CSP; staff downloads audited | API: bad-file tests, document isolation |
| Secrets stay server-side | no secrets in client bundles; `DATABASE_URL` uses the restricted role; service credentials only in environment | build output review; `.env` git-ignored |
| Security headers | CSP, `X-Frame-Options: DENY`, `nosniff`, referrer policy, permissions policy, HSTS (when `COOKIE_SECURE=true`) | API: header test |
| Supabase Data-API exposure | migration revokes all privileges from `anon`/`authenticated` | `003_auction_engine.sql` (not testable without Supabase) |
| Separation of duties | DB trigger: the submitter of an award cannot approve/reject it — even an administrator | DB + API |
| Webhook authenticity | Resend (Svix HMAC + 5-min replay window), WhatsApp (`X-Hub-Signature-256`), cron (`Bearer` secret, constant-time compare) | API: webhook tests |

## Verifying access control yourself (separate accounts)

The API suite does this automatically with a manager, an approver and four vendor accounts. To repeat manually on any environment: sign in as vendor A, copy a vendor-B RFQ URL → expect **404**; call `GET /api/rfqs`, `/api/audit`, `/api/users` with vendor A's cookie → **403**; try `POST /api/auctions/<id>/bids` as a manager → **403**; open `/admin` as a vendor → redirect to `/vendor`.

Database-level check (as the app role): `set app.mode='user'; set app.user_id='<vendor user id>'; select count(*) from bids;` → `0`.

## Known limitations

These are deliberate scope boundaries or things I could not do here. Address them before relying on the system for real awards:

1. **No MFA** for staff accounts. Strongly recommended for administrators and approvers.
2. **No antivirus / malware scan** of uploaded files (type is verified by content, but content is not scanned).
3. **Rate limiting is in-memory** (per process). With several instances use an edge limiter or a shared store.
4. **IP address trust:** `X-Forwarded-For` is trusted; the reverse proxy must overwrite it (the bundled Caddyfile does).
5. **CSP allows inline scripts** (`script-src 'self' 'unsafe-inline'`) because Next.js hydration uses them; a nonce-based CSP would be stricter.
6. **Not penetration-tested** by a third party. Tests assert the controls above, not the absence of unknown vulnerabilities.
7. **Notification providers untested live** (see docs/NOTIFICATIONS.md). Resend/Meta outages or template rejections surface as `failed`/`skipped`; they never block procurement actions.
8. **Documents live in PostgreSQL** — simple and consistent with backups, but not ideal for very large volumes; swap to object storage if needed.
9. **Own authentication, not Supabase Auth** — no social login/SSO. Password reset by e-mail needs a configured e-mail provider (an administrator can always reset a password).
10. **Single-region, single-database design**; no automatic failover is provided by the application.
11. **Account lockout can be abused for nuisance denial of service:** an attacker who knows an e-mail address can lock that account for 15 minutes by failing five logins (the lock self-expires; admins can reset immediately). A CAPTCHA or IP-reputation layer would mitigate this.
12. The audit hash chain detects tampering/deletion but cannot, on its own, prove *when* entries were written to an outside party; export and archive the audit log periodically (Audit → Excel) if you need external anchoring.
