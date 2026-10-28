-- 001_schema.sql — core relational schema for the Grainspan procurement & reverse-auction portal.
-- Money: numeric(12,2) ₹/MT and numeric(16,2) ₹ totals. Quantity: numeric(14,3) MT.
-- Timestamps: timestamptz (stored UTC, rendered in APP_TIMEZONE by the application).

-- ---------------------------------------------------------------- enums
create type app_role as enum ('admin', 'procurement_manager', 'approver', 'vendor', 'system');
create type vendor_status as enum ('pending', 'approved', 'suspended', 'rejected');
create type rfq_status as enum ('draft', 'published', 'quotation_open', 'qualification', 'scheduled', 'live', 'closed', 'cancelled', 'awarded');
create type auction_status as enum ('scheduled', 'live', 'closed', 'cancelled');
create type offer_status as enum ('draft', 'submitted', 'withdrawn');
create type qualification_status as enum ('pending', 'qualified', 'disqualified');
create type invitation_status as enum ('invited', 'viewed', 'declined');
create type award_status as enum ('draft', 'submitted', 'approved', 'rejected', 'published');
create type notification_channel as enum ('email', 'whatsapp');
create type notification_status as enum ('pending', 'processing', 'sent', 'delivered', 'failed', 'skipped');

-- ---------------------------------------------------------------- identity
create table profiles (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  full_name   text not null,
  phone       text,
  role        app_role not null,
  is_active   boolean not null default true,
  last_login_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_email_format check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or role = 'system')
);
create unique index profiles_email_uq on profiles (lower(email));

-- Credentials are deliberately in a separate table so password hashes can never be
-- returned by ordinary (user-mode) queries: RLS only opens this table to the auth bootstrap path.
create table user_credentials (
  user_id             uuid primary key references profiles(id) on delete cascade,
  password_hash       text not null,
  must_change_password boolean not null default false,
  failed_login_count  int not null default 0,
  locked_until        timestamptz,
  password_changed_at timestamptz not null default now()
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;

create table password_resets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- The system actor used by schedulers / background jobs. It has no credentials and cannot log in.
insert into profiles (id, email, full_name, role, is_active)
values ('00000000-0000-0000-0000-000000000001', 'system@grainspan.invalid', 'System', 'system', false);

-- ---------------------------------------------------------------- vendors
create sequence vendor_code_seq start 1;

create table vendors (
  id              uuid primary key default gen_random_uuid(),
  vendor_code     text not null unique default ('VND-' || lpad(nextval('vendor_code_seq')::text, 4, '0')),
  legal_name      text not null,
  gstin           text,
  pan             text,
  contact_name    text not null,
  contact_email   text not null,
  contact_phone   text,
  whatsapp_number text,                       -- E.164, e.g. +919876543210
  address         text,
  city            text,
  state           text,
  country         text not null default 'India',
  status          vendor_status not null default 'pending',
  status_reason   text,
  approved_by     uuid references profiles(id),
  approved_at     timestamptz,
  email_notifications    boolean not null default true,
  whatsapp_notifications boolean not null default true,
  is_demo         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint vendors_whatsapp_e164 check (whatsapp_number is null or whatsapp_number ~ '^\+[1-9][0-9]{7,14}$')
);
create unique index vendors_gstin_uq on vendors (upper(gstin)) where gstin is not null;
create index vendors_status_idx on vendors (status);

create table vendor_users (
  user_id    uuid primary key references profiles(id) on delete cascade,   -- a login belongs to exactly one vendor
  vendor_id  uuid not null references vendors(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index vendor_users_vendor_idx on vendor_users (vendor_id);

-- ---------------------------------------------------------------- RFQs
create sequence rfq_number_seq start 1;

create table rfqs (
  id                 uuid primary key default gen_random_uuid(),
  rfq_number         text not null unique default ('RFQ-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' || lpad(nextval('rfq_number_seq')::text, 4, '0')),
  material_name      text not null,
  grade              text,
  required_qty_mt    numeric(14,3) not null check (required_qty_mt > 0),
  min_gcv_arb        integer not null check (min_gcv_arb > 0),
  max_moisture_pct   numeric(5,2) not null check (max_moisture_pct >= 0 and max_moisture_pct <= 100),
  max_ash_pct        numeric(5,2) check (max_ash_pct is null or (max_ash_pct >= 0 and max_ash_pct <= 100)),
  origin             text,                     -- required / acceptable origin or country of origin
  other_specs        text,
  delivery_location  text not null,
  delivery_basis     text not null default 'FOR',
  delivery_schedule  text,
  payment_terms      text,
  quotation_open_at  timestamptz,
  quotation_deadline timestamptz,
  auction_start_at   timestamptz,
  auction_end_at     timestamptz,
  min_decrement      numeric(12,2) not null check (min_decrement > 0),   -- ₹/MT
  ext_enabled        boolean not null default false,
  ext_trigger_seconds integer not null default 120 check (ext_trigger_seconds > 0),
  ext_duration_seconds integer not null default 120 check (ext_duration_seconds > 0),
  ext_max_count      integer not null default 5 check (ext_max_count >= 0),
  coa_required       boolean not null default true,
  doc_requirements   text,
  additional_terms   text,
  -- 'strict': non-compliant quotations are rejected at submission; 'review': accepted but flagged for the qualification step.
  compliance_mode    text not null default 'strict' check (compliance_mode in ('strict', 'review')),
  status             rfq_status not null default 'draft',
  status_reason      text,
  created_by         uuid not null references profiles(id),
  published_at       timestamptz,
  cancelled_at       timestamptz,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint rfqs_schedule_complete check (
    status in ('draft', 'cancelled')
    or (quotation_deadline is not null and auction_start_at is not null and auction_end_at is not null)
  ),
  constraint rfqs_auction_window check (auction_end_at is null or auction_start_at is null or auction_end_at > auction_start_at),
  constraint rfqs_deadline_before_auction check (quotation_deadline is null or auction_start_at is null or quotation_deadline <= auction_start_at)
);
create index rfqs_status_idx on rfqs (status);

create table rfq_invitations (
  id             uuid primary key default gen_random_uuid(),
  rfq_id         uuid not null references rfqs(id) on delete cascade,
  vendor_id      uuid not null references vendors(id),
  status         invitation_status not null default 'invited',
  invited_by     uuid references profiles(id),
  invited_at     timestamptz not null default now(),
  viewed_at      timestamptz,
  declined_at    timestamptz,
  decline_reason text,
  unique (rfq_id, vendor_id)
);
create index rfq_invitations_vendor_idx on rfq_invitations (vendor_id);

-- ---------------------------------------------------------------- quotations
create table vendor_offers (
  id                    uuid primary key default gen_random_uuid(),
  rfq_id                uuid not null references rfqs(id) on delete cascade,
  vendor_id             uuid not null references vendors(id),
  origin                text,
  gcv_arb               integer check (gcv_arb is null or gcv_arb > 0),
  moisture_pct          numeric(5,2) check (moisture_pct is null or (moisture_pct >= 0 and moisture_pct <= 100)),
  ash_pct               numeric(5,2) check (ash_pct is null or (ash_pct >= 0 and ash_pct <= 100)),
  other_params          jsonb not null default '{}'::jsonb,
  qty_offered_mt        numeric(14,3) check (qty_offered_mt is null or qty_offered_mt > 0),
  initial_for_price     numeric(12,2) check (initial_for_price is null or initial_for_price > 0),
  lead_time_days        integer check (lead_time_days is null or lead_time_days >= 0),
  remarks               text,
  status                offer_status not null default 'draft',
  is_compliant          boolean,
  compliance_issues     jsonb not null default '[]'::jsonb,
  qualification_status  qualification_status not null default 'pending',
  qualification_remarks text,
  qualified_by          uuid references profiles(id),
  qualified_at          timestamptz,
  revision_allowed      boolean not null default false,   -- set by an admin when qualification is formally reopened
  submitted_at          timestamptz,
  version               integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (rfq_id, vendor_id)
);
create index vendor_offers_rfq_qual_idx on vendor_offers (rfq_id, qualification_status);

create table offer_documents (
  id          uuid primary key default gen_random_uuid(),
  offer_id    uuid not null references vendor_offers(id) on delete cascade,
  rfq_id      uuid not null references rfqs(id),
  vendor_id   uuid not null references vendors(id),
  doc_type    text not null check (doc_type in ('coa', 'supporting')),
  filename    text not null,
  mime_type   text not null,
  size_bytes  integer not null check (size_bytes > 0),
  sha256      text not null,
  uploaded_by uuid not null references profiles(id),
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references profiles(id)
);
create index offer_documents_offer_idx on offer_documents (offer_id);

create table document_blobs (
  document_id uuid primary key references offer_documents(id) on delete cascade,
  content     bytea not null
);

-- ---------------------------------------------------------------- auctions & bids
create table auctions (
  id                  uuid primary key default gen_random_uuid(),
  rfq_id              uuid not null references rfqs(id),
  status              auction_status not null default 'scheduled',
  start_at            timestamptz not null,
  end_at              timestamptz not null,          -- current (possibly extended) end
  scheduled_end_at    timestamptz not null,          -- originally scheduled end
  min_decrement       numeric(12,2) not null check (min_decrement > 0),
  ext_enabled         boolean not null default false,
  ext_trigger_seconds integer not null default 120,
  ext_duration_seconds integer not null default 120,
  ext_max_count       integer not null default 5,
  extension_count     integer not null default 0,
  opened_at           timestamptz,
  closed_at           timestamptz,
  closed_by           uuid references profiles(id),
  close_reason        text,
  closing_reminder_sent boolean not null default false,
  created_by          uuid references profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint auctions_window check (end_at > start_at)
);
-- Only one non-cancelled auction per RFQ at a time.
create unique index auctions_one_active_per_rfq on auctions (rfq_id) where status <> 'cancelled';
create index auctions_status_idx on auctions (status, start_at);

create table bids (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity,      -- total order of accepted bids; final tie-break
  auction_id      uuid not null references auctions(id),
  rfq_id          uuid not null references rfqs(id),
  vendor_id       uuid not null references vendors(id),
  offer_id        uuid not null references vendor_offers(id),
  user_id         uuid not null references profiles(id),
  amount          numeric(12,2) not null check (amount > 0),
  previous_amount numeric(12,2) not null check (previous_amount > 0),
  idempotency_key text not null,
  accepted_at     timestamptz not null default clock_timestamp(),
  client_ip       text,
  constraint bids_strictly_lower check (amount < previous_amount),
  unique (auction_id, vendor_id, idempotency_key)
);
create unique index bids_seq_uq on bids (seq);
create index bids_auction_vendor_idx on bids (auction_id, vendor_id, seq desc);

create table auction_events (
  id         bigint generated always as identity primary key,
  auction_id uuid references auctions(id),
  rfq_id     uuid references rfqs(id),
  event_type text not null,
  vendor_id  uuid references vendors(id),
  user_id    uuid references profiles(id),
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index auction_events_auction_idx on auction_events (auction_id, id);
create index auction_events_rfq_idx on auction_events (rfq_id, id);

-- ---------------------------------------------------------------- allocation & award
create table award_approvals (
  id                 uuid primary key default gen_random_uuid(),
  rfq_id             uuid not null references rfqs(id),
  cycle_no           integer not null default 1,
  status             award_status not null default 'draft',
  snapshot           jsonb,                         -- allocation lines frozen at submission
  total_allocated_mt numeric(14,3),
  total_value        numeric(18,2),
  submitted_by       uuid references profiles(id),
  submitted_at       timestamptz,
  submit_remarks     text,
  decided_by         uuid references profiles(id),
  decided_at         timestamptz,
  decision_remarks   text,
  published_by       uuid references profiles(id),
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (rfq_id, cycle_no)
);
-- At most one in-flight cycle per RFQ.
create unique index award_one_open_cycle on award_approvals (rfq_id) where status in ('draft', 'submitted', 'approved');

create table allocations (
  id               uuid primary key default gen_random_uuid(),
  rfq_id           uuid not null references rfqs(id),
  vendor_id        uuid not null references vendors(id),
  offer_id         uuid not null references vendor_offers(id),
  allocated_qty_mt numeric(14,3) not null default 0 check (allocated_qty_mt >= 0),
  remarks          text,
  updated_by       uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (rfq_id, vendor_id)
);

-- ---------------------------------------------------------------- notifications (outbox)
create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null,
  channel             notification_channel not null,
  rfq_id              uuid references rfqs(id),
  vendor_id           uuid references vendors(id),
  recipient           text,
  subject             text,
  payload             jsonb not null default '{}'::jsonb,
  status              notification_status not null default 'pending',
  attempts            integer not null default 0,
  max_attempts        integer not null default 5,
  next_attempt_at     timestamptz default now(),
  locked_at           timestamptz,
  last_error          text,
  provider            text,
  provider_message_id text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  failed_at           timestamptz,
  dedupe_key          text unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index notifications_queue_idx on notifications (next_attempt_at) where status = 'pending';
create index notifications_provider_msg_idx on notifications (provider_message_id) where provider_message_id is not null;
create index notifications_rfq_idx on notifications (rfq_id);

-- ---------------------------------------------------------------- audit trail (hash-chained, append-only)
create table audit_chain_head (
  id        smallint primary key default 1 check (id = 1),
  last_seq  bigint not null default 0,
  last_hash text not null default 'GENESIS'
);
insert into audit_chain_head default values;

create table audit_logs (
  id          bigint generated always as identity primary key,
  chain_seq   bigint not null unique,
  created_at  timestamptz not null default clock_timestamp(),
  actor_id    uuid,
  actor_role  text,
  actor_name  text,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  rfq_id      uuid,
  vendor_id   uuid,
  summary     text,
  before      jsonb,
  after       jsonb,
  metadata    jsonb,
  ip          text,
  prev_hash   text not null,
  row_hash    text not null
);
create index audit_logs_rfq_idx on audit_logs (rfq_id, id desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);
create index audit_logs_created_idx on audit_logs (created_at desc);
