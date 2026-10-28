-- 005_realtime_rfq_status.sql — push RFQ stage changes (publication, qualification, scheduling, award, cancellation…) to open browsers.
-- The notification is delivered only after COMMIT; it carries ids only, never prices. Subscribers re-read their own role-filtered snapshot.
create or replace function rfqs_notify_status() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  perform pg_notify('auction_events', jsonb_build_object('rfq_id', NEW.id, 'kind', 'status')::text);
  return null;
end $$;
create trigger rfqs_notify_status_t after update of status on rfqs for each row when (OLD.status is distinct from NEW.status) execute function rfqs_notify_status();
