# E-mail and WhatsApp notifications

> **Status:** both integrations call the providers' real HTTP APIs, but they have **only been exercised against local mock servers** (which verify URL, auth header, payload shape, idempotency keys, retry behaviour and webhook signatures). No real e-mail or WhatsApp message has been sent by this code. Follow the checklists below to prove delivery with your own accounts before relying on it.

## What is sent

| Event | `kind` | To | When |
|---|---|---|---|
| New RFQ invitation | `rfq_invitation` | each invited vendor | RFQ published (or vendor invited later) |
| Quotation deadline reminder | `quotation_reminder` | invited vendors **without a submitted quotation** | once at 24 h and once at 2 h before the deadline — skipped for a window that was already open when the RFQ was published |
| Auction opening | `auction_open` | qualified vendors | the server opens the auction |
| Auction closing reminder | `auction_closing_reminder` | qualified vendors | ≤ 5 min before the (possibly extended) end, once per end time |
| Auction closure | `auction_closed` | qualified vendors | closed by the scheduler or by an admin |
| Award (= quantity allocation publication) | `award` | vendors with an allocation > 0: quantity, accepted FOR price, value | award published |
| Non-award | `non_award` | qualified vendors with no allocation | award published |

Messages carry only the recipient's own data and a portal deep-link (sign-in required). No other vendor's name, price or quantity ever appears; this is asserted by the tests. Vendors can switch either channel off under **Profile**; opted-out/no-address cases are recorded as `skipped` with the reason.

## Delivery model (outbox)

Notification rows are written **in the same database transaction** as the business event (so there is never a notice without an event, or an event without its notice). A dispatcher then sends them:

| Status | Meaning |
|---|---|
| `pending` | queued, or waiting for the next retry (see *next attempt*) |
| `sent` | the provider API accepted it (has a provider message id) |
| `delivered` | the provider's webhook confirmed delivery |
| `failed` | permanent provider error, bounce, or retries exhausted |
| `skipped` | provider not configured, vendor opted out, or no address — **never silently reported as success** |

Retries: transient errors (network, timeout, HTTP 429/5xx, WhatsApp throughput codes) are retried after 1 min, 5 min, 30 min, 2 h, 6 h (max 5 attempts). Retries re-use the same Resend `Idempotency-Key` (the notification id), so a retry after a lost response cannot send a second e-mail. Permanent errors (4xx) fail immediately. Staff can re-queue a failed/skipped item from **Admin → Notifications → Retry** (refused if the vendor has since opted out). The Notifications page shows, per channel, whether the provider is **configured** and how many messages are pending / sent / delivered / failed / skipped.

## 1. E-mail — Resend

1. Create a [Resend](https://resend.com) account → **Domains → Add domain** (e.g. `grainspan.com`), add the DNS records (SPF, DKIM), wait for *Verified*.
2. **API keys → Create** (sending access). Put it in `RESEND_API_KEY`.
3. `EMAIL_FROM="Grainspan Procurement <procurement@grainspan.com>"` — must be on the verified domain.
4. Webhook (to get *delivered* / *bounced*): **Webhooks → Add endpoint** `https://<your domain>/api/webhooks/resend`, events `email.delivered`, `email.bounced`, `email.complained`, `email.failed`. Copy the signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET`. The endpoint verifies the Svix signature and rejects requests older than 5 minutes.
5. **Prove it:** publish a test RFQ inviting a vendor account whose e-mail you control → the Notifications page should go `pending → sent → delivered`. (Without the webhook it stays `sent`; the page warns about this.)

## 2. WhatsApp — Meta WhatsApp Business Cloud API

Business-initiated WhatsApp messages **must use pre-approved templates**. The app sends template messages only.

1. In [Meta Business Suite](https://business.facebook.com) create/verify a business, then in [developers.facebook.com](https://developers.facebook.com) create an app → add **WhatsApp**. Add a phone number (a number that is not already on the WhatsApp consumer app).
2. Note the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`. Create a **System User** token with `whatsapp_business_messaging` (permanent) → `WHATSAPP_ACCESS_TOKEN`. App secret (App settings → Basic) → `WHATSAPP_APP_SECRET`.
3. Create the **seven templates** below (WhatsApp Manager → Message templates), category **Utility**, language **English** (`en`; change `WHATSAPP_TEMPLATE_LANGUAGE` if you use another). Template names must equal the `WHATSAPP_TEMPLATE_*` variables (defaults shown). Meta rejects templates whose body starts or ends with a variable, so each ends with fixed text.
4. Webhook: App → WhatsApp → Configuration → Callback URL `https://<your domain>/api/webhooks/whatsapp`, Verify token = the value you choose for `WHATSAPP_VERIFY_TOKEN`, subscribe to **messages**. Statuses (`delivered`, `read`, `failed`) update the Notifications page; payloads are verified with `X-Hub-Signature-256`.
5. While your business is unverified, Meta only allows messages to numbers added as *test recipients*; use those first.
6. **Prove it:** same as e-mail — vendors need a `whatsapp_number` in E.164 form (`+919876543210`) on their profile.

### Template wording to submit (variables are positional `{{n}}`; the app fills them in this order)

| Template name (env var) | Body |
|---|---|
| `gnpl_rfq_invitation` (`WHATSAPP_TEMPLATE_RFQ_INVITATION`) | `Hello {{1}}, Grainspan Nutrients invites you to submit a quotation for {{2}} – {{3}}, quantity {{4}}. Quotation deadline: {{5}}. Open the RFQ in the supplier portal: {{6}}. This is an automated notice from Grainspan Procurement.` |
| `gnpl_quotation_reminder` (`…_QUOTATION_REMINDER`) | `Hello {{1}}, reminder: your quotation for {{2}} – {{3}} is due by {{4}}. Submit it in the supplier portal: {{5}}. – Grainspan Procurement` |
| `gnpl_auction_open` (`…_AUCTION_OPEN`) | `Hello {{1}}, the live reverse auction for {{2}} – {{3}} is now open and closes at {{4}}. Join and place your bids here: {{5}}. – Grainspan Procurement` |
| `gnpl_auction_closing` (`…_AUCTION_CLOSING`) | `Hello {{1}}, the auction for {{2}} – {{3}} closes at {{4}}. Submit any final price revision now: {{5}}. – Grainspan Procurement` |
| `gnpl_auction_closed` (`…_AUCTION_CLOSED`) | `Hello {{1}}, the auction for {{2}} – {{3}} has closed and bids are no longer accepted. Grainspan will communicate the outcome after evaluation. Portal: {{4}}. – Grainspan Procurement` |
| `gnpl_award` (`…_AWARD`) | `Hello {{1}}, Grainspan Nutrients has allocated {{4}} to your company for {{2}} – {{3}} at {{5}}. Details: {{6}}. A purchase order will follow separately. – Grainspan Procurement` |
| `gnpl_non_award` (`…_NON_AWARD`) | `Hello {{1}}, thank you for participating in {{2}} – {{3}}. On this occasion no quantity has been allocated to your company. Details: {{4}}. – Grainspan Procurement` |

Variable order per template (see `src/lib/notify/templates.ts → whatsappTemplate`): `{{1}}` vendor name, `{{2}}` RFQ number, `{{3}}` material, then — invitation: `{{4}}` quantity, `{{5}}` quotation deadline, `{{6}}` link · reminder: `{{4}}` deadline, `{{5}}` link · open/closing: `{{4}}` auction end, `{{5}}` link · closed/non-award: `{{4}}` link · award: `{{4}}` allocated quantity, `{{5}}` accepted price, `{{6}}` link. If Meta asks you to reword a template, keep the same variables in the same order (or edit `whatsappTemplate`).

## Environment variables

```
RESEND_API_KEY, EMAIL_FROM, RESEND_WEBHOOK_SECRET
WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN
WHATSAPP_API_VERSION (default v21.0), WHATSAPP_TEMPLATE_LANGUAGE (default en), WHATSAPP_TEMPLATE_* (names above)
```
Without credentials the channel shows **Not configured** and messages are recorded as `skipped` with the reason — the application keeps working.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Everything `skipped: provider not configured` | environment variables missing in the running process (restart after changing them) |
| E-mail `failed: Resend 403/422` | `EMAIL_FROM` domain not verified, or invalid recipient |
| WhatsApp `failed (code 132001)` | template name/language not approved or misspelled |
| WhatsApp `failed (code 131030)` | recipient not on the test-recipient list (unverified business) |
| `sent` but never `delivered` | delivery webhook not configured, wrong secret, or the URL is not publicly reachable |
