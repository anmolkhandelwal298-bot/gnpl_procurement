-- 004_app_adjustments.sql — small additions required by the application layer.

-- Invitations may be removed only while the RFQ is still a draft (published invitations are permanent, vendors may already have been notified).
create policy inv_delete on rfq_invitations for delete to grainspan_app
  using (is_editor() and exists (select 1 from rfqs r where r.id = rfq_invitations.rfq_id and r.status = 'draft'));
grant delete on rfq_invitations to grainspan_app;

-- Notification dispatcher bookkeeping
create index if not exists notifications_status_idx on notifications (status, created_at desc);
