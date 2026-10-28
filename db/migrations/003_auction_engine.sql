-- 003_auction_engine.sql — ranking, the atomic bid function, vendor-safe read functions, RLS policies and grants.
--
-- Ranking rule (documented, deterministic):
--   Only submitted + qualified quotations are ranked. Price = vendor's latest accepted bid, or their initial FOR price
--   if they have not bid. Ordered by: (1) lowest price, (2) earliest time the vendor reached that price (accepted_at of
--   the bid, or quotation submission time for an unrevised initial price), (3) lowest bid sequence number, (4) vendor id.
--   Rank 1 = lowest. Ties are therefore always resolved in favour of whoever reached the price first.

create or replace function compute_standings(p_rfq uuid, p_auction uuid)
returns table (vendor_id uuid, offer_id uuid, initial_price numeric, current_price numeric, price_at timestamptz,
               last_seq bigint, bid_count integer, rank integer)
language sql stable security definer set search_path = public, pg_temp as
$$
  with base as (
    select o.vendor_id, o.id as offer_id, o.initial_for_price as initial_price,
           coalesce(lb.amount, o.initial_for_price) as current_price,
           coalesce(lb.accepted_at, o.submitted_at) as price_at,
           coalesce(lb.seq, 0::bigint) as last_seq,
           coalesce(lb.n, 0)::integer as bid_count
    from vendor_offers o
    left join lateral (
      select b.amount, b.accepted_at, b.seq, count(*) over () as n
      from bids b where b.auction_id = p_auction and b.vendor_id = o.vendor_id
      order by b.seq desc limit 1
    ) lb on true
    where o.rfq_id = p_rfq and o.status = 'submitted' and o.qualification_status = 'qualified'
  )
  select base.vendor_id, base.offer_id, base.initial_price, base.current_price, base.price_at, base.last_seq, base.bid_count,
         (row_number() over (order by base.current_price asc, base.price_at asc, base.last_seq asc, base.vendor_id asc))::integer
  from base
$$;

-- Admin-only view of the full ranking for the RFQ's current (non-cancelled) auction.
create or replace function admin_standings(p_rfq uuid)
returns table (vendor_id uuid, offer_id uuid, initial_price numeric, current_price numeric, price_at timestamptz,
               last_seq bigint, bid_count integer, rank integer)
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if not is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from compute_standings(p_rfq, (select a.id from auctions a where a.rfq_id = p_rfq and a.status <> 'cancelled'));
end $$;

create or replace function auction_effective_status(a auctions, p_now timestamptz) returns text language sql immutable as
$$
  select case
    when a.status = 'cancelled' then 'cancelled'
    when a.status = 'closed' then 'closed'
    when p_now < a.start_at then 'scheduled'
    when p_now >= a.end_at then 'closed'
    else 'live'
  end
$$;

-- Internal: records a rejected bid as an auction event and returns the rejection payload.
create or replace function bid_reject(p_auction auctions, p_vendor uuid, p_user uuid, p_code text, p_message text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  insert into auction_events (auction_id, rfq_id, event_type, vendor_id, user_id, payload)
  values (p_auction.id, p_auction.rfq_id, 'bid_rejected', p_vendor, p_user,
          jsonb_build_object('code', p_code, 'message', p_message, 'attempted_amount', p_amount));
  return jsonb_build_object('ok', false, 'code', p_code, 'message', p_message);
end $$;

-- ================================================================= place_bid
-- The only way a bid is created. Atomic: the auction row is locked FOR UPDATE, so concurrent bids on one auction are
-- processed strictly one after another; the clock is clock_timestamp() read AFTER the lock is obtained.
create or replace function place_bid(p_auction_id uuid, p_amount numeric, p_idempotency_key text, p_client_ip text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_user uuid := app_user_id();
  v_vendor uuid;
  v_auction auctions%rowtype;
  v_offer vendor_offers%rowtype;
  v_existing bids%rowtype;
  v_bid bids%rowtype;
  v_now timestamptz;
  v_current numeric;
  v_rank integer;
  v_extended boolean := false;
  v_prev_end timestamptz;
  v_new_end timestamptz;
  v_reject_msg text;
begin
  if app_mode() <> 'user' or v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  v_vendor := app_approved_vendor_id();
  if v_vendor is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_ELIGIBLE', 'message', 'Your account is not eligible to bid in this auction.');
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 100 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'message', 'A valid idempotency key is required.');
  end if;

  -- Cheap pre-check (no lock): same generic answer whether the auction does not exist or the vendor is not eligible.
  if not exists (
    select 1 from auctions a
    join vendor_offers o on o.rfq_id = a.rfq_id and o.vendor_id = v_vendor and o.status = 'submitted' and o.qualification_status = 'qualified'
    join rfq_invitations i on i.rfq_id = a.rfq_id and i.vendor_id = v_vendor and i.status <> 'declined'
    where a.id = p_auction_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'NOT_ELIGIBLE', 'message', 'Your account is not eligible to bid in this auction.');
  end if;

  -- Serialise all bidding on this auction.
  select * into v_auction from auctions where id = p_auction_id for update;
  v_now := clock_timestamp();

  -- Idempotent retry: return the original result untouched.
  select * into v_existing from bids where auction_id = p_auction_id and vendor_id = v_vendor and idempotency_key = p_idempotency_key;
  if found then
    select s.rank into v_rank from compute_standings(v_auction.rfq_id, v_auction.id) s where s.vendor_id = v_vendor;
    return jsonb_build_object('ok', true, 'duplicate', true, 'rank', v_rank, 'end_at', v_auction.end_at, 'server_time', v_now,
      'bid', jsonb_build_object('id', v_existing.id, 'seq', v_existing.seq, 'amount', v_existing.amount,
                                'previous_amount', v_existing.previous_amount, 'accepted_at', v_existing.accepted_at));
  end if;

  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    return bid_reject(v_auction, v_vendor, v_user, 'INVALID_AMOUNT', 'Enter a positive FOR price with at most two decimal places.', p_amount);
  end if;
  if v_auction.status = 'cancelled' then
    return bid_reject(v_auction, v_vendor, v_user, 'AUCTION_CANCELLED', 'This auction has been cancelled.', p_amount);
  end if;
  if v_auction.status = 'closed' or v_now >= v_auction.end_at then
    return bid_reject(v_auction, v_vendor, v_user, 'AUCTION_CLOSED', 'The auction has closed. Bids are no longer accepted.', p_amount);
  end if;
  if v_now < v_auction.start_at then
    return bid_reject(v_auction, v_vendor, v_user, 'AUCTION_NOT_STARTED', 'The auction has not started yet.', p_amount);
  end if;

  select * into v_offer from vendor_offers where rfq_id = v_auction.rfq_id and vendor_id = v_vendor;
  select b.amount into v_current from bids b where b.auction_id = v_auction.id and b.vendor_id = v_vendor order by b.seq desc limit 1;
  v_current := coalesce(v_current, v_offer.initial_for_price);

  if p_amount >= v_current then
    v_reject_msg := format('Your bid must be lower than your current FOR price of ₹%s/MT.', to_char(v_current, 'FM999,999,990.00'));
    return bid_reject(v_auction, v_vendor, v_user, 'NOT_LOWER', v_reject_msg, p_amount);
  end if;
  if v_current - p_amount < v_auction.min_decrement then
    v_reject_msg := format('Each bid must be at least ₹%s/MT below your current FOR price of ₹%s/MT (maximum allowed: ₹%s/MT).',
                           to_char(v_auction.min_decrement, 'FM999,999,990.00'), to_char(v_current, 'FM999,999,990.00'),
                           to_char(v_current - v_auction.min_decrement, 'FM999,999,990.00'));
    return bid_reject(v_auction, v_vendor, v_user, 'BELOW_DECREMENT', v_reject_msg, p_amount);
  end if;

  insert into bids (auction_id, rfq_id, vendor_id, offer_id, user_id, amount, previous_amount, idempotency_key, accepted_at, client_ip)
  values (v_auction.id, v_auction.rfq_id, v_vendor, v_offer.id, v_user, p_amount, v_current, p_idempotency_key, v_now, p_client_ip)
  returning * into v_bid;

  insert into auction_events (auction_id, rfq_id, event_type, vendor_id, user_id, payload)
  values (v_auction.id, v_auction.rfq_id, 'bid_accepted', v_vendor, v_user,
          jsonb_build_object('bid_id', v_bid.id, 'seq', v_bid.seq, 'amount', p_amount, 'previous_amount', v_current));

  -- Anti-sniping extension (configurable per RFQ): a bid inside the trigger window pushes the close to now + duration.
  v_prev_end := v_auction.end_at;
  if v_auction.ext_enabled and v_auction.extension_count < v_auction.ext_max_count
     and (v_auction.end_at - v_now) <= make_interval(secs => v_auction.ext_trigger_seconds) then
    v_new_end := v_now + make_interval(secs => v_auction.ext_duration_seconds);
    if v_new_end > v_auction.end_at then
      update auctions set end_at = v_new_end, extension_count = extension_count + 1, closing_reminder_sent = false
       where id = v_auction.id returning * into v_auction;
      v_extended := true;
      insert into auction_events (auction_id, rfq_id, event_type, vendor_id, user_id, payload)
      values (v_auction.id, v_auction.rfq_id, 'auction_extended', v_vendor, v_user,
              jsonb_build_object('previous_end_at', v_prev_end, 'new_end_at', v_new_end, 'extension_count', v_auction.extension_count, 'trigger', 'late_bid'));
    end if;
  end if;

  select s.rank into v_rank from compute_standings(v_auction.rfq_id, v_auction.id) s where s.vendor_id = v_vendor;

  perform pg_notify('auction_events', jsonb_build_object('auction_id', v_auction.id, 'rfq_id', v_auction.rfq_id,
                    'kind', case when v_extended then 'bid_extended' else 'bid' end, 'seq', v_bid.seq)::text);

  return jsonb_build_object('ok', true, 'duplicate', false, 'rank', v_rank, 'extended', v_extended,
    'end_at', v_auction.end_at, 'server_time', v_now,
    'bid', jsonb_build_object('id', v_bid.id, 'seq', v_bid.seq, 'amount', v_bid.amount,
                              'previous_amount', v_bid.previous_amount, 'accepted_at', v_bid.accepted_at));
end $$;

-- ================================================================= vendor-safe reads
-- Vendors have no direct access to bids / auctions / events. They read ONLY their own state through these functions.
create or replace function vendor_auction_state(p_rfq uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  v_vendor uuid := app_approved_vendor_id();
  v_a auctions%rowtype;
  v_offer vendor_offers%rowtype;
  v_now timestamptz := clock_timestamp();
  v_eff text;
  v_current numeric;
  v_rank integer;
  v_count integer;
begin
  if v_vendor is null then return null; end if;
  select * into v_offer from vendor_offers where rfq_id = p_rfq and vendor_id = v_vendor;
  if not found or v_offer.status <> 'submitted' or v_offer.qualification_status <> 'qualified' then return null; end if;
  select * into v_a from auctions where rfq_id = p_rfq and status <> 'cancelled';
  if not found then return null; end if;
  v_eff := auction_effective_status(v_a, v_now);
  select s.current_price, s.rank, s.bid_count into v_current, v_rank, v_count
    from compute_standings(p_rfq, v_a.id) s where s.vendor_id = v_vendor;
  return jsonb_build_object(
    'auction_id', v_a.id, 'status', v_eff, 'start_at', v_a.start_at, 'end_at', v_a.end_at, 'server_time', v_now,
    'min_decrement', v_a.min_decrement, 'current_price', v_current, 'initial_price', v_offer.initial_for_price,
    'rank', case when v_eff in ('live', 'closed') then v_rank end,
    'bid_count', v_count,
    'max_next_bid', case when v_eff = 'live' then v_current - v_a.min_decrement end);
end $$;

create or replace function vendor_bid_history(p_auction uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_vendor uuid := app_approved_vendor_id(); v_a auctions%rowtype;
begin
  if v_vendor is null then return '[]'::jsonb; end if;
  select * into v_a from auctions where id = p_auction;
  if not found or not exists (select 1 from vendor_offers o where o.rfq_id = v_a.rfq_id and o.vendor_id = v_vendor
                              and o.status = 'submitted' and o.qualification_status = 'qualified') then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'at' desc) from (
      select jsonb_build_object('type', 'accepted', 'seq', b.seq, 'amount', b.amount, 'previous_amount', b.previous_amount, 'at', b.accepted_at) as x
        from bids b where b.auction_id = p_auction and b.vendor_id = v_vendor
      union all
      select jsonb_build_object('type', 'rejected', 'amount', (e.payload ->> 'attempted_amount')::numeric,
                                'code', e.payload ->> 'code', 'message', e.payload ->> 'message', 'at', e.created_at)
        from auction_events e where e.auction_id = p_auction and e.vendor_id = v_vendor and e.event_type = 'bid_rejected'
    ) q), '[]'::jsonb);
end $$;

create or replace function vendor_award_result(p_rfq uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v_vendor uuid := app_approved_vendor_id(); v_aw award_approvals%rowtype; v_line jsonb;
begin
  if v_vendor is null then return null; end if;
  if not exists (select 1 from vendor_offers o where o.rfq_id = p_rfq and o.vendor_id = v_vendor and o.status = 'submitted') then
    return null;
  end if;
  select * into v_aw from award_approvals where rfq_id = p_rfq and status = 'published';
  if not found then return jsonb_build_object('published', false); end if;
  select l into v_line from jsonb_array_elements(v_aw.snapshot) l where (l ->> 'vendor_id')::uuid = v_vendor;
  return jsonb_build_object('published', true, 'published_at', v_aw.published_at,
    'awarded', v_line is not null,
    'allocated_qty_mt', coalesce((v_line ->> 'allocated_qty_mt')::numeric, 0),
    'final_price', (v_line ->> 'final_price')::numeric,
    'value', (v_line ->> 'value')::numeric);
end $$;

-- ================================================================= account creation (SECURITY DEFINER, narrow)
create or replace function register_vendor(
  p_email text, p_full_name text, p_phone text, p_password_hash text,
  p_legal_name text, p_gstin text, p_pan text, p_contact_name text, p_contact_email text, p_contact_phone text,
  p_whatsapp text, p_address text, p_city text, p_state text, p_country text
) returns uuid language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_user uuid; v_vendor uuid;
begin
  if app_mode() <> 'auth' then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into profiles (email, full_name, phone, role) values (lower(btrim(p_email)), p_full_name, p_phone, 'vendor') returning id into v_user;
  insert into user_credentials (user_id, password_hash) values (v_user, p_password_hash);
  insert into vendors (legal_name, gstin, pan, contact_name, contact_email, contact_phone, whatsapp_number, address, city, state, country)
  values (p_legal_name, nullif(btrim(p_gstin), ''), nullif(btrim(p_pan), ''), p_contact_name, lower(btrim(p_contact_email)),
          nullif(btrim(p_contact_phone), ''), nullif(btrim(p_whatsapp), ''), nullif(btrim(p_address), ''),
          nullif(btrim(p_city), ''), nullif(btrim(p_state), ''), coalesce(nullif(btrim(p_country), ''), 'India'))
  returning id into v_vendor;
  insert into vendor_users (user_id, vendor_id, is_primary) values (v_user, v_vendor, true);
  perform audit_append('vendor.register', 'vendor', v_vendor::text, null, v_vendor, 'Vendor self-registration (pending approval)', null,
                       jsonb_build_object('legal_name', p_legal_name, 'email', lower(btrim(p_email))), null, null);
  return v_vendor;
end $$;

create or replace function admin_create_user(p_email text, p_full_name text, p_phone text, p_role app_role, p_password_hash text, p_must_change boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_user uuid;
begin
  if app_role() <> 'admin' then raise exception 'forbidden: administrator only' using errcode = '42501'; end if;
  if p_role not in ('admin', 'procurement_manager', 'approver') then
    raise exception 'staff accounts must be admin, procurement_manager or approver' using errcode = 'P0001';
  end if;
  insert into profiles (email, full_name, phone, role) values (lower(btrim(p_email)), p_full_name, p_phone, p_role) returning id into v_user;
  insert into user_credentials (user_id, password_hash, must_change_password) values (v_user, p_password_hash, coalesce(p_must_change, true));
  return v_user;
end $$;

-- ================================================================= RLS
do $$
declare t text;
begin
  foreach t in array array['profiles', 'user_credentials', 'sessions', 'password_resets', 'vendors', 'vendor_users', 'rfqs',
    'rfq_invitations', 'vendor_offers', 'offer_documents', 'document_blobs', 'auctions', 'bids', 'auction_events',
    'award_approvals', 'allocations', 'notifications', 'audit_logs', 'audit_chain_head'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- credentials / sessions: reachable only from the authentication bootstrap path and background jobs
create policy cred_all on user_credentials for all to grainspan_app using (app_mode() in ('auth', 'system')) with check (app_mode() in ('auth', 'system'));
create policy sess_all on sessions for all to grainspan_app using (app_mode() in ('auth', 'system')) with check (app_mode() in ('auth', 'system'));
create policy pwreset_all on password_resets for all to grainspan_app using (app_mode() in ('auth', 'system')) with check (app_mode() in ('auth', 'system'));

create policy profiles_select on profiles for select to grainspan_app
  using (app_mode() in ('auth', 'system') or id = app_user_id() or is_staff());
create policy profiles_insert on profiles for insert to grainspan_app with check (app_mode() = 'system');
create policy profiles_update on profiles for update to grainspan_app
  using (app_mode() in ('auth', 'system') or id = app_user_id() or app_role() = 'admin')
  with check (app_mode() in ('auth', 'system') or id = app_user_id() or app_role() = 'admin');

create policy vendors_select on vendors for select to grainspan_app
  using (is_staff() or id = app_vendor_id_any() or app_mode() = 'auth');
create policy vendors_insert on vendors for insert to grainspan_app with check (is_editor());
create policy vendors_update on vendors for update to grainspan_app
  using (is_editor() or id = app_vendor_id_any()) with check (is_editor() or id = app_vendor_id_any());

create policy vendor_users_select on vendor_users for select to grainspan_app
  using (is_staff() or user_id = app_user_id() or app_mode() = 'auth');
create policy vendor_users_write on vendor_users for all to grainspan_app using (is_editor()) with check (is_editor());

create policy rfqs_select on rfqs for select to grainspan_app
  using (is_staff() or (status <> 'draft' and exists (
    select 1 from rfq_invitations i where i.rfq_id = rfqs.id and i.vendor_id = app_approved_vendor_id())));
create policy rfqs_insert on rfqs for insert to grainspan_app with check (is_editor());
create policy rfqs_update on rfqs for update to grainspan_app using (is_editor()) with check (is_editor());

create policy inv_select on rfq_invitations for select to grainspan_app using (is_staff() or vendor_id = app_approved_vendor_id());
create policy inv_insert on rfq_invitations for insert to grainspan_app with check (is_editor());
create policy inv_update on rfq_invitations for update to grainspan_app
  using (is_editor() or vendor_id = app_approved_vendor_id()) with check (is_editor() or vendor_id = app_approved_vendor_id());

create policy offers_select on vendor_offers for select to grainspan_app using (is_staff() or vendor_id = app_approved_vendor_id());
create policy offers_insert on vendor_offers for insert to grainspan_app with check (vendor_id = app_approved_vendor_id() or app_mode() = 'system');
create policy offers_update on vendor_offers for update to grainspan_app
  using (is_editor() or vendor_id = app_approved_vendor_id()) with check (is_editor() or vendor_id = app_approved_vendor_id());

create policy docs_select on offer_documents for select to grainspan_app using (is_staff() or vendor_id = app_approved_vendor_id());
create policy docs_insert on offer_documents for insert to grainspan_app with check (vendor_id = app_approved_vendor_id() or app_mode() = 'system');
create policy docs_update on offer_documents for update to grainspan_app
  using (vendor_id = app_approved_vendor_id() or app_mode() = 'system') with check (vendor_id = app_approved_vendor_id() or app_mode() = 'system');
create policy blobs_select on document_blobs for select to grainspan_app
  using (is_staff() or exists (select 1 from offer_documents d where d.id = document_id and d.vendor_id = app_approved_vendor_id()));
create policy blobs_insert on document_blobs for insert to grainspan_app
  with check (app_mode() = 'system' or exists (select 1 from offer_documents d where d.id = document_id and d.vendor_id = app_approved_vendor_id()));

-- Vendors get NO direct policy on auctions, bids or auction_events: they read through the vendor_* functions only.
create policy auctions_select on auctions for select to grainspan_app using (is_staff());
create policy auctions_insert on auctions for insert to grainspan_app with check (is_editor());
create policy auctions_update on auctions for update to grainspan_app using (is_editor()) with check (is_editor());
create policy bids_select on bids for select to grainspan_app using (is_staff());
create policy events_select on auction_events for select to grainspan_app using (is_staff());
create policy events_insert on auction_events for insert to grainspan_app with check (is_editor());

create policy awards_select on award_approvals for select to grainspan_app using (is_staff());
create policy awards_insert on award_approvals for insert to grainspan_app with check (is_editor());
create policy awards_update on award_approvals for update to grainspan_app using (is_staff()) with check (is_staff());
create policy alloc_select on allocations for select to grainspan_app using (is_staff());
create policy alloc_insert on allocations for insert to grainspan_app with check (is_editor());
create policy alloc_update on allocations for update to grainspan_app using (is_editor()) with check (is_editor());

create policy notif_select on notifications for select to grainspan_app using (is_staff());
create policy notif_insert on notifications for insert to grainspan_app with check (is_editor());
create policy notif_update on notifications for update to grainspan_app using (is_editor()) with check (is_editor());

create policy audit_select on audit_logs for select to grainspan_app using (is_staff());

-- ================================================================= grants
revoke all on all tables in schema public from public;
revoke all on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;

grant select, insert, update on profiles, vendors, vendor_users, rfqs, rfq_invitations, vendor_offers, offer_documents,
  auctions, award_approvals, allocations, notifications to grainspan_app;
grant select, insert, update, delete on user_credentials, sessions, password_resets to grainspan_app;
grant select, insert on document_blobs, auction_events to grainspan_app;
grant select on bids, audit_logs to grainspan_app;          -- NO insert/update/delete on bids or audit_logs
grant usage, select on sequence rfq_number_seq, vendor_code_seq to grainspan_app;
-- vendor_users: staff may re-link users; deletion is not granted.

grant execute on function app_mode(), app_user_id(), app_role(), is_staff(), is_editor(), app_vendor_id_any(),
  app_approved_vendor_id(), actor_name() to grainspan_app;
grant execute on function place_bid(uuid, numeric, text, text), vendor_auction_state(uuid), vendor_bid_history(uuid),
  vendor_award_result(uuid), admin_standings(uuid), write_audit(text, text, text, uuid, uuid, text, jsonb, jsonb, jsonb, text),
  verify_audit_chain(), register_vendor(text, text, text, text, text, text, text, text, text, text, text, text, text, text, text),
  admin_create_user(text, text, text, app_role, text, boolean), rfq_transition_allowed(rfq_status, rfq_status),
  auction_effective_status(auctions, timestamptz) to grainspan_app;
-- compute_standings, bid_reject, audit_append, audit_digest are internal and intentionally NOT granted.

-- Supabase hardening: if the Data API roles exist, they must never reach these objects.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
