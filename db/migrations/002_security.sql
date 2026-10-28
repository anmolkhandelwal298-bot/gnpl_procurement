-- 002_security.sql — roles, request-context helpers, integrity triggers, audit chain, RLS policies and grants.
--
-- Request context model
--   The Next.js server connects as the NON-superuser role `grainspan_app` (no BYPASSRLS). For every request it opens a
--   transaction and sets two transaction-local settings AFTER it has authenticated the session cookie:
--       app.mode    = 'user' | 'auth' | 'system'
--       app.user_id = <profiles.id>               (user mode; system mode uses the system profile)
--   RLS policies and SECURITY DEFINER functions read those settings, so even a bug in application code that forgets a
--   WHERE clause cannot return another vendor's rows.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'grainspan_app') then
    create role grainspan_app nologin nosuperuser nocreatedb nocreaterole nobypassrls inherit;
  end if;
end $$;

do $$ begin execute format('grant connect on database %I to grainspan_app', current_database()); end $$;
grant usage on schema public to grainspan_app;

-- ---------------------------------------------------------------- context helpers
create or replace function app_mode() returns text language sql stable as
$$ select coalesce(nullif(current_setting('app.mode', true), ''), 'none') $$;

create or replace function app_user_id() returns uuid language sql stable as
$$ select case when app_mode() in ('user', 'system') then nullif(current_setting('app.user_id', true), '')::uuid end $$;

create or replace function app_role() returns text language sql stable security definer set search_path = public, pg_temp as
$$
  select case app_mode()
    when 'system' then 'system'
    when 'user' then (select p.role::text from profiles p where p.id = app_user_id() and p.is_active)
    else 'anon'
  end
$$;

create or replace function is_staff() returns boolean language sql stable as
$$ select coalesce(app_role() in ('admin', 'procurement_manager', 'approver', 'system'), false) $$;

create or replace function is_editor() returns boolean language sql stable as
$$ select coalesce(app_role() in ('admin', 'procurement_manager', 'system'), false) $$;

-- vendor of the current user regardless of approval state (own profile page)
create or replace function app_vendor_id_any() returns uuid language sql stable security definer set search_path = public, pg_temp as
$$ select vu.vendor_id from vendor_users vu where vu.user_id = app_user_id() and app_mode() = 'user' and app_role() = 'vendor' $$;

-- vendor of the current user, only when the vendor is approved (everything commercial)
create or replace function app_approved_vendor_id() returns uuid language sql stable security definer set search_path = public, pg_temp as
$$
  select vu.vendor_id from vendor_users vu join vendors v on v.id = vu.vendor_id
  where vu.user_id = app_user_id() and app_mode() = 'user' and app_role() = 'vendor' and v.status = 'approved'
$$;

create or replace function actor_name() returns text language sql stable security definer set search_path = public, pg_temp as
$$ select p.full_name from profiles p where p.id = app_user_id() $$;

-- ---------------------------------------------------------------- audit trail (hash chain)
create or replace function audit_digest(
  p_prev text, p_seq bigint, p_created timestamptz, p_actor_id uuid, p_actor_role text, p_actor_name text,
  p_action text, p_entity_type text, p_entity_id text, p_rfq_id uuid, p_vendor_id uuid, p_summary text,
  p_before jsonb, p_after jsonb, p_metadata jsonb, p_ip text
) returns text language sql immutable as
$$
  select encode(sha256(convert_to(concat_ws('|',
    p_prev, p_seq::text,
    to_char(p_created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(p_actor_id::text, ''), coalesce(p_actor_role, ''), coalesce(p_actor_name, ''),
    p_action, p_entity_type, coalesce(p_entity_id, ''), coalesce(p_rfq_id::text, ''), coalesce(p_vendor_id::text, ''),
    coalesce(p_summary, ''), coalesce(p_before::text, ''), coalesce(p_after::text, ''), coalesce(p_metadata::text, ''),
    coalesce(p_ip, '')
  ), 'UTF8')), 'hex')
$$;

create or replace function audit_append(
  p_action text, p_entity_type text, p_entity_id text, p_rfq_id uuid, p_vendor_id uuid, p_summary text,
  p_before jsonb, p_after jsonb, p_metadata jsonb, p_ip text
) returns bigint language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  h audit_chain_head%rowtype;
  v_created timestamptz := clock_timestamp();
  v_uid uuid := app_user_id();
  v_role text := app_role();
  v_name text := actor_name();
  v_hash text;
  v_id bigint;
begin
  -- Row lock on the chain head serialises writers: chain order == commit order.
  update audit_chain_head set last_seq = last_seq + 1 where id = 1 returning * into h;
  v_hash := audit_digest(h.last_hash, h.last_seq, v_created, v_uid, v_role, v_name, p_action, p_entity_type, p_entity_id,
                         p_rfq_id, p_vendor_id, p_summary, p_before, p_after, p_metadata, p_ip);
  insert into audit_logs (chain_seq, created_at, actor_id, actor_role, actor_name, action, entity_type, entity_id, rfq_id,
                          vendor_id, summary, before, after, metadata, ip, prev_hash, row_hash)
  values (h.last_seq, v_created, v_uid, v_role, v_name, p_action, p_entity_type, p_entity_id, p_rfq_id, p_vendor_id,
          p_summary, p_before, p_after, p_metadata, p_ip, h.last_hash, v_hash)
  returning id into v_id;
  update audit_chain_head set last_hash = v_hash where id = 1;
  return v_id;
end $$;

-- Application-level audit entries (login, export, publish, ...). Actor is taken from the DB context, never from the caller.
create or replace function write_audit(
  p_action text, p_entity_type text, p_entity_id text, p_rfq_id uuid, p_vendor_id uuid, p_summary text,
  p_before jsonb, p_after jsonb, p_metadata jsonb, p_ip text
) returns bigint language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if app_mode() not in ('user', 'system', 'auth') then
    raise exception 'audit requires an application context' using errcode = '28000';
  end if;
  return audit_append(p_action, p_entity_type, p_entity_id, p_rfq_id, p_vendor_id, p_summary, p_before, p_after, p_metadata, p_ip);
end $$;

-- Walks the chain in order and recomputes every hash. Returns the first broken sequence, if any.
create or replace function verify_audit_chain()
returns table (ok boolean, checked bigint, first_bad_seq bigint, reason text)
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  r audit_logs%rowtype;
  v_prev text := 'GENESIS';
  v_expect_seq bigint := 1;
  v_n bigint := 0;
  v_head audit_chain_head%rowtype;
begin
  if not is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in select * from audit_logs order by chain_seq loop
    v_n := v_n + 1;
    if r.chain_seq <> v_expect_seq then
      return query select false, v_n, v_expect_seq, 'missing or out-of-order chain_seq'::text; return;
    end if;
    if r.prev_hash <> v_prev then
      return query select false, v_n, r.chain_seq, 'prev_hash does not match previous row'::text; return;
    end if;
    if r.row_hash <> audit_digest(r.prev_hash, r.chain_seq, r.created_at, r.actor_id, r.actor_role, r.actor_name, r.action,
                                  r.entity_type, r.entity_id, r.rfq_id, r.vendor_id, r.summary, r.before, r.after,
                                  r.metadata, r.ip) then
      return query select false, v_n, r.chain_seq, 'row content does not match its hash'::text; return;
    end if;
    v_prev := r.row_hash;
    v_expect_seq := v_expect_seq + 1;
  end loop;
  select * into v_head from audit_chain_head where id = 1;
  if v_head.last_seq <> v_n or v_head.last_hash <> v_prev then
    return query select false, v_n, v_n + 1, 'chain head does not match last row (rows removed?)'::text; return;
  end if;
  return query select true, v_n, null::bigint, null::text;
end $$;

-- Generic row-change audit trigger. TG_ARGV[0] = entity name.
create or replace function audit_row_change() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_old jsonb := case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(OLD) end;
  v_new jsonb := case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(NEW) end;
  v_ref jsonb := coalesce(v_new, v_old);
  v_drop text[] := array['updated_at', 'password_hash', 'content'];
  v_before jsonb; v_after jsonb; v_action text;
  v_rfq uuid; v_vendor uuid;
begin
  if TG_OP = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into v_after
      from jsonb_each(v_new) n where (v_old -> n.key) is distinct from n.value and n.key <> all (v_drop);
    select coalesce(jsonb_object_agg(o.key, o.value), '{}'::jsonb) into v_before
      from jsonb_each(v_old) o where (v_new -> o.key) is distinct from o.value and o.key <> all (v_drop);
    if v_after = '{}'::jsonb then return NEW; end if;
    v_action := TG_ARGV[0] || case when v_after ? 'status' then '.status_change' else '.update' end;
  elsif TG_OP = 'INSERT' then
    v_after := v_new - v_drop; v_action := TG_ARGV[0] || '.create';
  else
    v_before := v_old - v_drop; v_action := TG_ARGV[0] || '.delete';
  end if;
  v_rfq := case when TG_ARGV[0] = 'rfq' then (v_ref ->> 'id')::uuid else (v_ref ->> 'rfq_id')::uuid end;
  v_vendor := case when TG_ARGV[0] = 'vendor' then (v_ref ->> 'id')::uuid else (v_ref ->> 'vendor_id')::uuid end;
  perform audit_append(v_action, TG_ARGV[0], v_ref ->> 'id', v_rfq, v_vendor, null, v_before, v_after, null, null);
  return coalesce(NEW, OLD);
end $$;

-- ---------------------------------------------------------------- immutability
create or replace function forbid_mutation() returns trigger language plpgsql as
$$
begin
  raise exception '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP using errcode = '42501';
end $$;

create trigger bids_append_only before update or delete on bids for each row execute function forbid_mutation();
create trigger bids_no_truncate before truncate on bids for each statement execute function forbid_mutation();
create trigger auction_events_append_only before update or delete on auction_events for each row execute function forbid_mutation();
create trigger auction_events_no_truncate before truncate on auction_events for each statement execute function forbid_mutation();
create trigger audit_logs_append_only before update or delete on audit_logs for each row execute function forbid_mutation();
create trigger audit_logs_no_truncate before truncate on audit_logs for each statement execute function forbid_mutation();

create or replace function touch_updated_at() returns trigger language plpgsql as
$$ begin NEW.updated_at := now(); return NEW; end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'vendors', 'rfqs', 'vendor_offers', 'auctions', 'award_approvals', 'allocations', 'notifications'] loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- profile / vendor guards
create or replace function profiles_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if TG_OP = 'UPDATE' and app_mode() = 'user' and app_role() is distinct from 'admin' then
    if NEW.role is distinct from OLD.role or NEW.is_active is distinct from OLD.is_active or NEW.email is distinct from OLD.email then
      raise exception 'only an administrator can change role, status or email' using errcode = '42501';
    end if;
  end if;
  return NEW;
end $$;
create trigger profiles_guard_t before update on profiles for each row execute function profiles_guard();

create or replace function vendors_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_role text := app_role();
begin
  if TG_OP = 'UPDATE' then
    if v_role = 'vendor' then
      if NEW.status is distinct from OLD.status or NEW.vendor_code is distinct from OLD.vendor_code
         or NEW.is_demo is distinct from OLD.is_demo or NEW.legal_name is distinct from OLD.legal_name
         or NEW.gstin is distinct from OLD.gstin or NEW.pan is distinct from OLD.pan
         or NEW.approved_by is distinct from OLD.approved_by or NEW.approved_at is distinct from OLD.approved_at then
        raise exception 'vendors may only update contact details and notification preferences' using errcode = '42501';
      end if;
    elsif v_role = 'approver' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if NEW.status is distinct from OLD.status then
      if NEW.status = 'approved' then
        NEW.approved_by := app_user_id(); NEW.approved_at := now();
      end if;
    end if;
  end if;
  return NEW;
end $$;
create trigger vendors_guard_t before update on vendors for each row execute function vendors_guard();

-- ---------------------------------------------------------------- RFQ state machine
create or replace function rfq_transition_allowed(a rfq_status, b rfq_status) returns boolean language sql immutable as
$$
  select (a::text, b::text) in (
    ('draft', 'published'), ('draft', 'quotation_open'), ('draft', 'cancelled'),
    ('published', 'quotation_open'), ('published', 'cancelled'),
    ('quotation_open', 'qualification'), ('quotation_open', 'cancelled'),
    ('qualification', 'scheduled'), ('qualification', 'cancelled'),
    ('scheduled', 'live'), ('scheduled', 'qualification'), ('scheduled', 'cancelled'),
    ('live', 'closed'), ('live', 'qualification'), ('live', 'cancelled'),
    ('closed', 'awarded'), ('closed', 'cancelled')
  )
$$;

create or replace function rfqs_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_role text := app_role();
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then raise exception 'RFQs must be created in draft status' using errcode = 'P0001'; end if;
    return NEW;
  end if;

  if NEW.status is distinct from OLD.status then
    if not rfq_transition_allowed(OLD.status, NEW.status) then
      raise exception 'INVALID_TRANSITION: % -> % is not allowed', OLD.status, NEW.status using errcode = 'P0001';
    end if;
    if NEW.status = 'cancelled' and v_role not in ('admin', 'procurement_manager', 'system') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if OLD.status = 'live' and NEW.status = 'qualification' and v_role not in ('admin', 'system') then
      raise exception 'only an administrator can reopen qualification once an auction has started' using errcode = '42501';
    end if;
    if NEW.status = 'scheduled' and not exists (select 1 from auctions a where a.rfq_id = NEW.id and a.status = 'scheduled') then
      raise exception 'INVALID_TRANSITION: no scheduled auction exists for this RFQ' using errcode = 'P0001';
    end if;
    if NEW.status = 'live' and not exists (select 1 from auctions a where a.rfq_id = NEW.id and a.status = 'live') then
      raise exception 'INVALID_TRANSITION: no live auction exists for this RFQ' using errcode = 'P0001';
    end if;
    if NEW.status = 'closed' and not exists (select 1 from auctions a where a.rfq_id = NEW.id and a.status = 'closed') then
      raise exception 'INVALID_TRANSITION: auction is not closed' using errcode = 'P0001';
    end if;
    if NEW.status = 'awarded' and not exists (select 1 from award_approvals w where w.rfq_id = NEW.id and w.status = 'published') then
      raise exception 'INVALID_TRANSITION: no published award exists' using errcode = 'P0001';
    end if;
    if NEW.status = 'published' then NEW.published_at := coalesce(NEW.published_at, now()); end if;
    if NEW.status = 'cancelled' then NEW.cancelled_at := now(); end if;
  end if;

  -- Specifications and commercial terms are frozen once the RFQ leaves draft (vendors have quoted against them).
  if OLD.status <> 'draft' then
    if NEW.material_name is distinct from OLD.material_name or NEW.grade is distinct from OLD.grade
       or NEW.required_qty_mt is distinct from OLD.required_qty_mt or NEW.min_gcv_arb is distinct from OLD.min_gcv_arb
       or NEW.max_moisture_pct is distinct from OLD.max_moisture_pct or NEW.max_ash_pct is distinct from OLD.max_ash_pct
       or NEW.origin is distinct from OLD.origin or NEW.other_specs is distinct from OLD.other_specs
       or NEW.delivery_location is distinct from OLD.delivery_location or NEW.delivery_basis is distinct from OLD.delivery_basis
       or NEW.delivery_schedule is distinct from OLD.delivery_schedule or NEW.payment_terms is distinct from OLD.payment_terms
       or NEW.coa_required is distinct from OLD.coa_required or NEW.compliance_mode is distinct from OLD.compliance_mode
       or NEW.min_decrement is distinct from OLD.min_decrement or NEW.rfq_number is distinct from OLD.rfq_number then
      raise exception 'SPEC_LOCKED: specifications and commercial terms cannot change after publication' using errcode = 'P0001';
    end if;
    if OLD.status in ('closed', 'awarded', 'cancelled', 'live')
       and (NEW.quotation_deadline is distinct from OLD.quotation_deadline) then
      raise exception 'SPEC_LOCKED: the quotation deadline can no longer be changed' using errcode = 'P0001';
    end if;
  end if;
  return NEW;
end $$;
create trigger rfqs_guard_t before insert or update on rfqs for each row execute function rfqs_guard();

-- ---------------------------------------------------------------- invitations
create or replace function invitations_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_role text := app_role(); v_rfq rfqs%rowtype;
begin
  select * into v_rfq from rfqs where id = NEW.rfq_id;
  if TG_OP = 'INSERT' then
    if not exists (select 1 from vendors v where v.id = NEW.vendor_id and v.status = 'approved') then
      raise exception 'VENDOR_NOT_APPROVED: only approved vendors can be invited' using errcode = 'P0001';
    end if;
    if v_rfq.status not in ('draft', 'published', 'quotation_open') then
      raise exception 'INVALID_STATE: vendors can no longer be invited to this RFQ' using errcode = 'P0001';
    end if;
  elsif v_role = 'vendor' then
    if NEW.rfq_id <> OLD.rfq_id or NEW.vendor_id <> OLD.vendor_id or NEW.invited_by is distinct from OLD.invited_by
       or NEW.invited_at <> OLD.invited_at then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if NEW.status = 'declined' and OLD.status <> 'declined' and v_rfq.status not in ('published', 'quotation_open') then
      raise exception 'INVALID_STATE: the invitation can no longer be declined' using errcode = 'P0001';
    end if;
  end if;
  return NEW;
end $$;
create trigger invitations_guard_t before insert or update on rfq_invitations for each row execute function invitations_guard();

-- ---------------------------------------------------------------- quotations (vendor_offers)
create or replace function offer_editable_by_vendor(p_offer uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as
$$
  select exists (
    select 1 from vendor_offers o join rfqs r on r.id = o.rfq_id
    where o.id = p_offer
      and ((r.status = 'quotation_open' and clock_timestamp() < r.quotation_deadline)
           or (r.status = 'qualification' and o.revision_allowed))
  )
$$;

create or replace function offers_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_role text := app_role();
  v_rfq rfqs%rowtype;
  v_editable boolean;
  v_issues jsonb := '[]'::jsonb;
  v_missing text[] := '{}';
  v_coa int;
  v_tech_changed boolean := false;
begin
  select * into v_rfq from rfqs where id = NEW.rfq_id;

  if TG_OP = 'UPDATE' then
    v_tech_changed := NEW.origin is distinct from OLD.origin or NEW.gcv_arb is distinct from OLD.gcv_arb
      or NEW.moisture_pct is distinct from OLD.moisture_pct or NEW.ash_pct is distinct from OLD.ash_pct
      or NEW.other_params is distinct from OLD.other_params or NEW.qty_offered_mt is distinct from OLD.qty_offered_mt
      or NEW.initial_for_price is distinct from OLD.initial_for_price or NEW.lead_time_days is distinct from OLD.lead_time_days
      or NEW.remarks is distinct from OLD.remarks or NEW.status is distinct from OLD.status;
  end if;

  if v_role = 'vendor' then
    if NEW.vendor_id is distinct from app_approved_vendor_id() then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if TG_OP = 'INSERT' and not exists (
        select 1 from rfq_invitations i where i.rfq_id = NEW.rfq_id and i.vendor_id = NEW.vendor_id and i.status <> 'declined') then
      raise exception 'forbidden: not invited to this RFQ' using errcode = '42501';
    end if;
    if TG_OP = 'UPDATE' and (NEW.rfq_id <> OLD.rfq_id or NEW.vendor_id <> OLD.vendor_id
        or NEW.qualification_status is distinct from OLD.qualification_status
        or NEW.qualification_remarks is distinct from OLD.qualification_remarks
        or NEW.qualified_by is distinct from OLD.qualified_by or NEW.revision_allowed is distinct from OLD.revision_allowed) then
      -- the only permitted staff-column change by a vendor is the automatic reset applied below, never a direct edit
      raise exception 'forbidden: qualification fields are controlled by Grainspan' using errcode = '42501';
    end if;
    if TG_OP = 'INSERT' then
      v_editable := v_rfq.status = 'quotation_open' and clock_timestamp() < v_rfq.quotation_deadline;
      NEW.qualification_status := 'pending'; NEW.revision_allowed := false;
      NEW.qualification_remarks := null; NEW.qualified_by := null; NEW.qualified_at := null;
    else
      v_editable := (v_rfq.status = 'quotation_open' and clock_timestamp() < v_rfq.quotation_deadline)
                    or (v_rfq.status = 'qualification' and OLD.revision_allowed);
    end if;
    if not v_editable then
      raise exception 'OFFER_LOCKED: this quotation can no longer be changed' using errcode = 'P0001';
    end if;
    if TG_OP = 'UPDATE' and OLD.revision_allowed and v_tech_changed then
      -- an approved post-deadline revision: consume the permission and send the quotation back through qualification
      NEW.revision_allowed := false; NEW.qualification_status := 'pending';
      NEW.qualification_remarks := null; NEW.qualified_by := null; NEW.qualified_at := null;
    end if;
  else
    -- Staff may only drive qualification; a vendor's technical data is never edited on their behalf.
    if TG_OP = 'INSERT' and v_role is distinct from 'system' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if TG_OP = 'UPDATE' then
      if v_tech_changed then raise exception 'forbidden: technical data can only be changed by the vendor' using errcode = '42501'; end if;
      if NEW.qualification_status is distinct from OLD.qualification_status or NEW.revision_allowed is distinct from OLD.revision_allowed then
        if v_role not in ('admin', 'procurement_manager', 'system') then raise exception 'forbidden' using errcode = '42501'; end if;
        if v_rfq.status not in ('quotation_open', 'qualification') then
          raise exception 'QUAL_LOCKED: qualification cannot change while the RFQ is %', v_rfq.status using errcode = 'P0001';
        end if;
        if NEW.revision_allowed and v_rfq.status <> 'qualification' then
          raise exception 'QUAL_LOCKED: revisions can only be granted during qualification' using errcode = 'P0001';
        end if;
        if NEW.qualification_status <> 'pending' and NEW.status <> 'submitted' then
          raise exception 'QUAL_LOCKED: only submitted quotations can be qualified' using errcode = 'P0001';
        end if;
        if NEW.qualification_status is distinct from OLD.qualification_status then
          NEW.qualified_by := app_user_id(); NEW.qualified_at := now();
        end if;
      end if;
    end if;
    return NEW;
  end if;

  -- Vendor submission: completeness (always enforced) and technical compliance (per RFQ mode)
  if NEW.status = 'submitted' then
    if NEW.origin is null or btrim(NEW.origin) = '' then v_missing := array_append(v_missing, 'origin'::text); end if;
    if NEW.gcv_arb is null then v_missing := array_append(v_missing, 'gcv_arb'::text); end if;
    if NEW.moisture_pct is null then v_missing := array_append(v_missing, 'moisture_pct'::text); end if;
    if v_rfq.max_ash_pct is not null and NEW.ash_pct is null then v_missing := array_append(v_missing, 'ash_pct'::text); end if;
    if NEW.qty_offered_mt is null then v_missing := array_append(v_missing, 'qty_offered_mt'::text); end if;
    if NEW.initial_for_price is null then v_missing := array_append(v_missing, 'initial_for_price'::text); end if;
    if NEW.lead_time_days is null then v_missing := array_append(v_missing, 'lead_time_days'::text); end if;
    if array_length(v_missing, 1) > 0 then
      raise exception 'INCOMPLETE: missing %', array_to_string(v_missing, ', ') using errcode = 'P0001';
    end if;
    if NEW.gcv_arb < v_rfq.min_gcv_arb then
      v_issues := v_issues || jsonb_build_object('field', 'gcv_arb', 'message', format('GCV (ARB) %s is below the required minimum of %s kcal/kg', NEW.gcv_arb, v_rfq.min_gcv_arb));
    end if;
    if NEW.moisture_pct > v_rfq.max_moisture_pct then
      v_issues := v_issues || jsonb_build_object('field', 'moisture_pct', 'message', format('Total moisture %s%% exceeds the maximum of %s%%', NEW.moisture_pct, v_rfq.max_moisture_pct));
    end if;
    if v_rfq.max_ash_pct is not null and NEW.ash_pct > v_rfq.max_ash_pct then
      v_issues := v_issues || jsonb_build_object('field', 'ash_pct', 'message', format('Ash %s%% exceeds the maximum of %s%%', NEW.ash_pct, v_rfq.max_ash_pct));
    end if;
    if v_rfq.coa_required then
      select count(*) into v_coa from offer_documents d where d.offer_id = NEW.id and d.doc_type = 'coa' and d.removed_at is null;
      if v_coa = 0 then
        v_issues := v_issues || jsonb_build_object('field', 'coa', 'message', 'A Certificate of Analysis (COA) must be uploaded');
      end if;
    end if;
    NEW.compliance_issues := v_issues;
    NEW.is_compliant := jsonb_array_length(v_issues) = 0;
    if not NEW.is_compliant and v_rfq.compliance_mode = 'strict' then
      raise exception 'NON_COMPLIANT: %', v_issues::text using errcode = 'P0001';
    end if;
    if TG_OP = 'INSERT' or OLD.status <> 'submitted' or v_tech_changed then
      NEW.submitted_at := now();
    end if;
  end if;
  if TG_OP = 'UPDATE' and v_tech_changed then NEW.version := OLD.version + 1; end if;
  return NEW;
end $$;
create trigger offers_guard_t before insert or update on vendor_offers for each row execute function offers_guard();

create or replace function documents_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if app_role() = 'vendor' then
    if NEW.vendor_id is distinct from app_approved_vendor_id() then raise exception 'forbidden' using errcode = '42501'; end if;
    if not offer_editable_by_vendor(NEW.offer_id) then
      raise exception 'OFFER_LOCKED: documents can no longer be changed' using errcode = 'P0001';
    end if;
    if TG_OP = 'UPDATE' and (NEW.sha256 <> OLD.sha256 or NEW.filename <> OLD.filename or NEW.offer_id <> OLD.offer_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif app_role() is distinct from 'system' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return NEW;
end $$;
create trigger documents_guard_t before insert or update on offer_documents for each row execute function documents_guard();

-- ---------------------------------------------------------------- auctions (admin-side writes)
create or replace function auctions_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if TG_OP = 'UPDATE' and OLD.status in ('closed', 'cancelled') and NEW.status is distinct from OLD.status then
    raise exception 'INVALID_TRANSITION: auction is %', OLD.status using errcode = 'P0001';
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'live' and NEW.status = 'scheduled' then
    raise exception 'INVALID_TRANSITION: a live auction cannot return to scheduled' using errcode = 'P0001';
  end if;
  if TG_OP = 'UPDATE' and NEW.min_decrement is distinct from OLD.min_decrement and OLD.status <> 'scheduled' then
    raise exception 'the minimum decrement cannot change once the auction has started' using errcode = 'P0001';
  end if;
  return NEW;
end $$;
create trigger auctions_guard_t before update on auctions for each row execute function auctions_guard();

-- ---------------------------------------------------------------- allocations & awards
create or replace function allocations_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_rfq rfqs%rowtype; v_offer vendor_offers%rowtype;
begin
  if app_role() not in ('admin', 'procurement_manager', 'system') then
    raise exception 'forbidden: only procurement staff can edit allocations' using errcode = '42501';
  end if;
  select * into v_rfq from rfqs where id = NEW.rfq_id;
  select * into v_offer from vendor_offers where id = NEW.offer_id;
  if v_rfq.status <> 'closed' then
    raise exception 'INVALID_STATE: allocations can only be edited after the auction has closed (status is %)', v_rfq.status using errcode = 'P0001';
  end if;
  if v_offer.rfq_id <> NEW.rfq_id or v_offer.vendor_id <> NEW.vendor_id then
    raise exception 'offer does not belong to this vendor and RFQ' using errcode = 'P0001';
  end if;
  if NEW.allocated_qty_mt > 0 and (v_offer.qualification_status <> 'qualified' or v_offer.status <> 'submitted') then
    raise exception 'NOT_QUALIFIED: quantity can only be allocated to qualified vendors' using errcode = 'P0001';
  end if;
  if NEW.allocated_qty_mt > v_offer.qty_offered_mt then
    raise exception 'OVER_OFFERED: allocation % MT exceeds the offered quantity of % MT', NEW.allocated_qty_mt, v_offer.qty_offered_mt using errcode = 'P0001';
  end if;
  if exists (select 1 from award_approvals w where w.rfq_id = NEW.rfq_id and w.status in ('submitted', 'approved', 'published')) then
    raise exception 'ALLOCATION_LOCKED: the allocation is submitted or approved and cannot be edited' using errcode = 'P0001';
  end if;
  if TG_OP = 'UPDATE' and (NEW.rfq_id <> OLD.rfq_id or NEW.vendor_id <> OLD.vendor_id or NEW.offer_id <> OLD.offer_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  NEW.updated_by := app_user_id();
  return NEW;
end $$;
create trigger allocations_guard_t before insert or update on allocations for each row execute function allocations_guard();

create or replace function allocations_total_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_total numeric; v_req numeric;
begin
  select coalesce(sum(allocated_qty_mt), 0) into v_total from allocations where rfq_id = NEW.rfq_id;
  select required_qty_mt into v_req from rfqs where id = NEW.rfq_id;
  if v_total > v_req then
    raise exception 'OVER_REQUIREMENT: total allocation % MT exceeds the RFQ requirement of % MT', v_total, v_req using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger allocations_total_t after insert or update on allocations
  deferrable initially deferred for each row execute function allocations_total_check();

create or replace function awards_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
declare v_role text := app_role(); v_rfq rfqs%rowtype; v_snap jsonb; v_qty numeric; v_val numeric;
begin
  select * into v_rfq from rfqs where id = NEW.rfq_id;
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then raise exception 'award cycles start as draft' using errcode = 'P0001'; end if;
    if v_role not in ('admin', 'procurement_manager', 'system') then raise exception 'forbidden' using errcode = '42501'; end if;
    if v_rfq.status <> 'closed' then raise exception 'INVALID_STATE: the auction must be closed before an award is prepared' using errcode = 'P0001'; end if;
    NEW.cycle_no := coalesce((select max(cycle_no) from award_approvals where rfq_id = NEW.rfq_id), 0) + 1;
    return NEW;
  end if;

  if NEW.rfq_id <> OLD.rfq_id or NEW.cycle_no <> OLD.cycle_no then raise exception 'forbidden' using errcode = '42501'; end if;
  if OLD.status in ('rejected', 'published') then
    raise exception 'INVALID_TRANSITION: award cycle is already %', OLD.status using errcode = 'P0001';
  end if;
  if NEW.status is not distinct from OLD.status then
    if NEW.snapshot is distinct from OLD.snapshot then raise exception 'snapshot is immutable' using errcode = '42501'; end if;
    return NEW;
  end if;

  if OLD.status = 'draft' and NEW.status = 'submitted' then
    if v_role not in ('admin', 'procurement_manager') then raise exception 'forbidden: only procurement managers can submit an award for approval' using errcode = '42501'; end if;
    select jsonb_agg(jsonb_build_object(
             'vendor_id', a.vendor_id, 'vendor_code', v.vendor_code, 'vendor_name', v.legal_name, 'offer_id', a.offer_id,
             'rank', s.rank, 'final_price', s.current_price, 'offered_qty_mt', o.qty_offered_mt,
             'allocated_qty_mt', a.allocated_qty_mt, 'value', round(a.allocated_qty_mt * s.current_price, 2), 'remarks', a.remarks)
           order by s.rank),
           coalesce(sum(a.allocated_qty_mt), 0), coalesce(sum(round(a.allocated_qty_mt * s.current_price, 2)), 0)
      into v_snap, v_qty, v_val
      from allocations a
      join vendors v on v.id = a.vendor_id
      join vendor_offers o on o.id = a.offer_id
      join compute_standings(a.rfq_id, (select au.id from auctions au where au.rfq_id = a.rfq_id and au.status = 'closed')) s on s.vendor_id = a.vendor_id
      where a.rfq_id = NEW.rfq_id and a.allocated_qty_mt > 0;
    if v_qty is null or v_qty <= 0 then
      raise exception 'EMPTY_ALLOCATION: allocate a quantity to at least one vendor before submitting' using errcode = 'P0001';
    end if;
    NEW.snapshot := v_snap; NEW.total_allocated_mt := v_qty; NEW.total_value := v_val;
    NEW.submitted_by := app_user_id(); NEW.submitted_at := now();
  elsif OLD.status = 'submitted' and NEW.status in ('approved', 'rejected') then
    if v_role not in ('admin', 'approver') then raise exception 'forbidden: only approvers can decide on an award' using errcode = '42501'; end if;
    if OLD.submitted_by = app_user_id() then
      raise exception 'SEPARATION_OF_DUTIES: the person who submitted an award cannot approve or reject it' using errcode = 'P0001';
    end if;
    if NEW.status = 'rejected' and (NEW.decision_remarks is null or btrim(NEW.decision_remarks) = '') then
      raise exception 'a rejection requires remarks' using errcode = 'P0001';
    end if;
    NEW.decided_by := app_user_id(); NEW.decided_at := now();
  elsif OLD.status = 'approved' and NEW.status = 'published' then
    if v_role not in ('admin', 'approver') then raise exception 'forbidden: only approvers can publish an award' using errcode = '42501'; end if;
    NEW.published_by := app_user_id(); NEW.published_at := now();
  else
    raise exception 'INVALID_TRANSITION: % -> %', OLD.status, NEW.status using errcode = 'P0001';
  end if;
  if NEW.snapshot is distinct from OLD.snapshot and OLD.status <> 'draft' then
    raise exception 'snapshot is immutable' using errcode = '42501';
  end if;
  return NEW;
end $$;
create trigger awards_guard_t before insert or update on award_approvals for each row execute function awards_guard();

-- Publishing an award atomically marks the RFQ as awarded (approvers have no direct write access to rfqs).
create or replace function awards_after_publish() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if NEW.status = 'published' and OLD.status is distinct from 'published' then
    update rfqs set status = 'awarded' where id = NEW.rfq_id and status = 'closed';
    if not found then
      raise exception 'INVALID_STATE: the RFQ must be closed to publish an award' using errcode = 'P0001';
    end if;
  end if;
  return null;
end $$;
create trigger awards_after_publish_t after update on award_approvals for each row execute function awards_after_publish();

-- ---------------------------------------------------------------- audit triggers on business tables
create trigger audit_rfqs after insert or update or delete on rfqs for each row execute function audit_row_change('rfq');
create trigger audit_invitations after insert or update or delete on rfq_invitations for each row execute function audit_row_change('invitation');
create trigger audit_offers after insert or update or delete on vendor_offers for each row execute function audit_row_change('offer');
create trigger audit_documents after insert or update on offer_documents for each row execute function audit_row_change('document');
create trigger audit_vendors after insert or update or delete on vendors for each row execute function audit_row_change('vendor');
create trigger audit_profiles after insert or update or delete on profiles for each row execute function audit_row_change('user');
create trigger audit_auctions after insert or update or delete on auctions for each row execute function audit_row_change('auction');
create trigger audit_allocations after insert or update or delete on allocations for each row execute function audit_row_change('allocation');
create trigger audit_awards after insert or update or delete on award_approvals for each row execute function audit_row_change('award');
