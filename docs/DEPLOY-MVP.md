# Put the prototype online (no laptop, no commands)

You only need a web browser and two accounts: **GitHub** (the code is already there) and **[Render](https://render.com)**. About 10 minutes.

> **Honest status:** the start-up flow below was tested here from an *empty database* using the same environment variables the blueprint sets, and it came up healthy, created the admin, loaded demo data, accepted logins and was safe to restart. It has **not** been run on Render itself (no Render account was available), so treat the first deploy as the real test. If something fails, the log tells you why — see *Troubleshooting*.

## What you get

A public HTTPS URL running the full portal (admin + vendor), pre-loaded with **DEMO** vendors and one DEMO RFQ, with one-click demo logins on the sign-in page, so you can show or test everything immediately. No e-mail/WhatsApp is sent until you add provider keys (they show as "skipped").

## Steps (Render)

1. **Sign in to Render with GitHub** and allow it to read the `gnpl_procurement` repository (Render → *Account Settings → GitHub*; private repositories are fine).
2. **New → Blueprint**. Pick the repository `gnpl_procurement` and the branch **`claude/vibrant-cray-qcl75e`** (that is where the code lives; Render shows `render.yaml` and what it will create: one web service + one PostgreSQL database).
3. Render asks for the values marked *sync: false*. Fill in only these:
   * `BOOTSTRAP_ADMIN_EMAIL` — your e-mail (this becomes **your real administrator login**)
   * `BOOTSTRAP_ADMIN_PASSWORD` — a temporary password, at least 10 characters with a letter and a number (you must change it at first sign-in)
   * leave the e-mail / WhatsApp keys empty for now.
4. Click **Apply**. The first build takes several minutes (Docker build). When the service shows **Live**, open its URL (`https://grainspan-procurement-xxxx.onrender.com`).
5. **Check** `…/api/health` shows `{"ok":true,"db":"up"}`, then open the home page. Use the amber **Prototype — DEMO accounts** box to sign in as the manager, approver or any vendor, or sign in with your own admin e-mail.

Everything else (database tables, the restricted database user, secrets such as `SESSION_SECRET`, the public URL) is configured automatically on every start by `scripts/boot.ts`.

## Try the whole flow in 5 minutes

1. Sign in as **manager** → *RFQs → + New RFQ* (or open the DEMO RFQ). Invite two vendors, set the deadline a few hours ahead, **Publish**.
2. In **two separate private/incognito windows** sign in as `kalinga@vendor.demo` and `sagar@vendor.demo` (click the buttons). Each opens the RFQ, fills the quotation, uploads any PDF as the COA, **Submit**.
3. As manager: *Quotations → Qualify* both → *Overview → Close quotations now → Schedule auction* (start 2–3 minutes from now).
4. Keep both vendor windows on the RFQ page. When the countdown ends the bid form appears. Bid from one vendor — the **other window's rank changes by itself**.
5. Manager: *Close auction now* → *Allocation & award* → enter quantities → *Submit*. Sign in as **approver** → *Approve → Publish*. Vendors see their own award. *Audit & reports → Verify audit-chain integrity*.

## Prototype limits (free plans) — read before relying on it

| Limit | Effect | Source |
|---|---|---|
| Free web services **sleep after 15 minutes without traffic**; waking takes up to a minute | While asleep nothing runs: auctions do not open/close on time and reminders pause. Bids are still validated by the database clock, and the scheduler catches up on wake, but a **live auction needs an always-on instance** | [Render free-tier docs](https://render.com/docs/free) |
| Free PostgreSQL **expires 30 days** after creation, 1 GB, **no backups** | Data is lost/inaccessible after expiry unless upgraded | [Render free-tier docs](https://render.com/docs/free) |
| Anyone with the URL can click the demo logins | **Do not enter real commercial data** while `DEMO_LOGIN_HINT` is on; treat the URL as private | — |

For anything beyond a demo: in the Render dashboard set both plans to a paid tier (e.g. *Starter*), then in the web service's **Environment** set `SEED_DEMO=false`, `DEMO_LOGIN_HINT=false`, `SHOW_DEMO_BANNER=false`. Existing demo accounts stay in the database; deactivate them under *Staff users* / suspend the demo vendors, or start with a fresh database. Then follow the launch checklist in [DEPLOYMENT.md](DEPLOYMENT.md).

## If the database refuses to create a role

The app protects vendor data with a restricted database user (`grainspan_app`) that it creates itself, so the database login you give it must be allowed to create roles. Most managed Postgres services allow this, but I could not confirm it for Render's database. If the deploy log ends with *"permission denied to create/alter role"*, use a free **[Neon](https://neon.tech)** database instead:

1. Create a Neon project, copy its **connection string** (it looks like `postgres://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require`).
2. In Render open the web service → **Environment** → set `MIGRATION_DATABASE_URL` to that string (replace the value that pointed at the Render database) → **Save** (it redeploys).
3. If the log complains about certificates, add `DATABASE_SSL` = `no-verify`.
4. You can delete the unused Render database from the dashboard.

Supabase's database also works in principle (same variable), but the app was only tested against a plain local PostgreSQL; direct Supabase connections are IPv6-only, which some hosts cannot reach.

## Other hosts

The `Dockerfile` runs on any container host (Railway, Fly.io, Cloud Run, a VPS). Set the same variables as in `render.yaml`:
`MIGRATION_DATABASE_URL` (the database's owner connection string), `SESSION_SECRET` (any 32+ random characters), `APP_URL` (your public URL, if the host doesn't set one), optionally `BOOTSTRAP_ADMIN_*`, `SEED_DEMO`, `DEMO_LOGIN_HINT`. The container listens on `$PORT`. Keep **one always-on instance**.

## Troubleshooting

| Deploy log says | Meaning / fix |
|---|---|
| `SESSION_SECRET must be set…` | add `SESSION_SECRET` (any long random string); the blueprint generates one |
| `cannot connect to the database` | wrong `MIGRATION_DATABASE_URL`, or the database is still starting (it retries for a minute) |
| `permission denied to create role` / `alter role` | see the section above |
| `restricted runtime role cannot connect` | set `DATABASE_SSL=no-verify`; with connection poolers the username format may differ — use a direct/session connection |
| `admin password rejected` | `BOOTSTRAP_ADMIN_PASSWORD` needs ≥ 10 characters with a letter and a number |
| Page loads but sign-in says "Origin"/cookie problems | open the site on its own `https://` URL (not an embedded frame or a different hostname than `APP_URL`) |
| First visit takes ~1 minute | the free instance was asleep |

## Updating later

Push to the branch Render is tracking; it rebuilds and redeploys, and the start-up script applies any new database migrations automatically.
