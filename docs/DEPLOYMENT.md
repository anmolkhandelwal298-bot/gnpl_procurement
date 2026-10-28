# Deployment, backup and launch checklist

> **Status:** the application has *not* been deployed by the author — no hosting or database credentials were available. Everything below is written to be followed step by step; items marked **(untested)** have not been run in this form.

## What the app needs from a host

| Need | Why |
|---|---|
| A **long-running Node 20+ process** (not serverless) | Live auctions use Server-Sent Events and the in-process scheduler (auction open/close, reminders, notification retries). |
| PostgreSQL 15+ | Data, RLS, the auction engine, `LISTEN/NOTIFY` realtime. |
| A **direct (non-pooled) or session-mode** Postgres connection for the realtime listener | `LISTEN` does not work through a transaction pooler. Set `DATABASE_URL_LISTEN` if `DATABASE_URL` points at a pooler. |
| HTTPS, ideally **HTTP/2** | Secure cookies; HTTP/2 removes the browser's 6-connection-per-host limit that live pages would otherwise use up. |
| Outbound HTTPS to `api.resend.com` and `graph.facebook.com` | Notifications. |

**Vercel:** the serverless model is not suitable as-is (SSE connections and the scheduler need a persistent process). You *can* host the database and static assets elsewhere, but run the Next.js server on a container host.

## Option A — one VPS with Docker Compose (Postgres + app + automatic HTTPS) **(untested)**

1. Create a server (2 vCPU / 2 GB is plenty) with Docker + Compose, and point a DNS `A` record (e.g. `procurement.grainspan.com`) at it. Open ports 80 and 443.
2. `git clone` the repository and create `.env` next to `docker-compose.yml`:
   ```bash
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   APP_DB_PASSWORD=$(openssl rand -hex 24)
   SESSION_SECRET=$(openssl rand -hex 32)
   CRON_SECRET=$(openssl rand -hex 24)
   DOMAIN=procurement.grainspan.com
   APP_URL=https://procurement.grainspan.com
   APP_TIMEZONE=Asia/Kolkata
   # + provider variables from docs/NOTIFICATIONS.md
   ```
3. `docker compose up -d --build` — the `migrate` job applies `db/migrations` and sets the `grainspan_app` password; then the app starts; Caddy obtains the TLS certificate automatically.
4. Create the first administrator (the demo seed refuses to run in production):
   ```bash
   docker compose run --rm -e ADMIN_EMAIL=you@grainspan.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD='a-long-temporary-passw0rd' migrate npx tsx scripts/create-admin.ts
   ```
   Sign in at `https://<domain>/login`; you will be forced to change the password. Create the other staff accounts under **Staff users**.
5. Check `https://<domain>/api/health` → `{"ok":true,"db":"up"}`.

## Option B — container host + managed PostgreSQL (e.g. Supabase) **(untested)**

1. **Database.** In Supabase create a project (or any managed Postgres ≥ 15). Collect two connection strings:
   * *Owner / migration* connection (the `postgres` user, direct or session mode) → `MIGRATION_DATABASE_URL`.
   * The *app* connection later uses the restricted role the migration creates (`grainspan_app`).
2. **Migrate** from your laptop or CI (needs Node):
   ```bash
   export MIGRATION_DATABASE_URL='postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'
   export APP_DB_PASSWORD='<long random password for the app role>'
   export DATABASE_SSL=true            # (or no-verify if your CA bundle is not available)
   npm ci && npm run db:migrate
   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npx tsx scripts/create-admin.ts
   ```
   `002/003` create the `grainspan_app` role, enable RLS on every table, and **revoke all access from the `anon`/`authenticated` roles** so Supabase's auto-generated Data API cannot reach these tables. Additionally, in the Supabase dashboard disable the Data API (or remove `public` from *Exposed schemas*) — the application does not use it.
3. **App.** Build the image (`docker build -t grainspan-procurement .`) and deploy it on Fly.io / Render / Railway / ECS / Cloud Run (min 1 instance, *not* scale-to-zero — the scheduler must run). Set:
   ```
   DATABASE_URL=postgres://grainspan_app:<APP_DB_PASSWORD>@<host>:5432/postgres     # session-mode / direct or pooler
   DATABASE_URL_LISTEN=<direct or session-mode connection string>                    # required if the line above is a transaction pooler
   DATABASE_SSL=true
   APP_URL=https://<your domain>  APP_TIMEZONE=Asia/Kolkata
   SESSION_SECRET=… CRON_SECRET=… COOKIE_SECURE=true RUN_SCHEDULER=true SHOW_DEMO_BANNER=false
   (+ RESEND_*, WHATSAPP_* — see docs/NOTIFICATIONS.md)
   ```
   Build arg `NEXT_PUBLIC_APP_TIMEZONE` (default `Asia/Kolkata`) is inlined into the browser bundle.
4. Attach your domain with HTTPS; confirm the platform supports long-lived responses (SSE) and does not buffer them.
5. **Several instances:** supported for correctness (all time-based jobs use `SKIP LOCKED`, bids are DB-serialised, the realtime hub is per-process and every instance listens), but the in-memory rate limiter then becomes per-instance — front it with an edge rate limiter or replace `src/lib/rate-limit.ts` with a shared store. Run `RUN_SCHEDULER=true` on at least one instance; extra instances are harmless.

### Supabase caveats to know before you choose it
* Supabase Auth, Realtime and Storage are **not used**; the app has its own session auth, SSE realtime and Postgres document storage (see README → Design decisions).
* The migrations were developed and tested on PostgreSQL 16 only. On Supabase run them as the `postgres` user and read the output; a failing `create role`/`grant` would mean the project's role permissions differ from the assumption that `postgres` may create roles.

## Scheduler
The app runs its own scheduler (every 2 s). As a safety net, an external pinger can call `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute (GitHub Actions, UptimeRobot, Cloud Scheduler). The endpoint is idempotent. Bid validity never depends on the scheduler: `place_bid()` checks the database clock itself.

## Backup and recovery

* **What to protect:** the PostgreSQL database holds *everything*, including uploaded COAs (table `document_blobs`) and the audit chain. There is no other state (sessions are in the DB; secrets are environment variables — keep them in a password manager).
* **Backups**
  * Managed Postgres: enable **point-in-time recovery** (Supabase: PITR add-on or daily backups) and retain ≥ 30 days.
  * Self-hosted: nightly logical dump + WAL archiving if you need PITR:
    ```bash
    docker compose exec -T db pg_dump -U postgres -Fc grainspan > backups/grainspan-$(date +%F).dump
    ```
    Copy dumps off the server (S3/GCS with versioning and object lock). Encrypt at rest.
* **Restore drill (do this before go-live and quarterly):**
  ```bash
  createdb restore_test
  pg_restore -d restore_test --no-owner backups/grainspan-YYYY-MM-DD.dump
  psql restore_test -c "select * from verify_audit_chain();"   # run as a staff context, or sign in and use Audit → Verify chain
  ```
  Then point a staging copy of the app at it and sign in. After restoring into a *new* database re-run `npm run db:migrate` (grants/roles) and re-set the `grainspan_app` password.
* **Audit-chain verification:** `Audit & reports → Verify audit-chain integrity` recomputes every hash. Run it after any restore, any DB-level maintenance, and monthly. A failure means rows were altered or removed outside the application.
* **Incident basics:** to cut a user off immediately use Staff users → Deactivate (sessions are revoked at once) or Vendors → Suspend. To rotate `SESSION_SECRET` (invalidates every session) just change the variable and restart.

## Production launch checklist

**Before go-live**
- [ ] Domain + HTTPS working; `COOKIE_SECURE=true`; HSTS header present (`curl -sI https://<domain>/login`).
- [ ] `SESSION_SECRET` ≥ 32 random bytes, `CRON_SECRET` set, `APP_DB_PASSWORD` unique; nothing from `.env` is committed.
- [ ] App connects as `grainspan_app` (not `postgres`): `select current_user, rolbypassrls from pg_roles where rolname=current_user;` run through the app's `DATABASE_URL` shows `grainspan_app | f`.
- [ ] Demo seed **not** run; no `*.demo` accounts exist; `SHOW_DEMO_BANNER=false`.
- [ ] First admin created; all demo/test passwords changed; each staff member has their own account.
- [ ] Data API of the managed provider disabled / not exposing `public`.
- [ ] Resend domain verified, `EMAIL_FROM` on that domain; webhook configured and a test e-mail shows **delivered** (Notifications page).
- [ ] WhatsApp templates **approved**, a test template message reaches a real handset, webhook verified.
- [ ] Send a real test RFQ to two test vendor accounts end-to-end (publish → quote → qualify → auction → allocate → approve → publish) on the production URL.
- [ ] Verify access control with separate accounts: a vendor cannot open `/admin`, another vendor's RFQ URL returns 404, vendor APIs under `/api/rfqs` return 403 (the HTTP test suite does this; repeat manually on production).
- [ ] Backups enabled and a **restore drill completed**.
- [ ] Uptime monitoring on `/api/health`; alerting on 5xx and on notification `failed` counts.
- [ ] Time zone confirmed (`APP_TIMEZONE`, build arg `NEXT_PUBLIC_APP_TIMEZONE`) and server clock synchronised (NTP) — auction fairness depends on it.
- [ ] Reverse proxy overwrites `X-Forwarded-For` (the bundled Caddyfile does); otherwise clients can spoof IPs and weaken per-IP rate limits.

**Strongly recommended before handling real commercial awards** (not built — see docs/SECURITY.md): MFA for staff, antivirus scanning of uploads, an external penetration test, a shared rate-limit store if you run several instances.
