import { api, EDITORS, uid } from "@/lib/http";
import { DomainError, withSystem } from "@/lib/db";
import { processNotificationQueue } from "@/lib/notify/dispatcher";

export const POST = api<{ id: string }>({ roles: EDITORS, limit: { name: "requeue", max: 30, windowSec: 60 } }, async ({ user, params }) => {
  const id = uid(params.id);
  const ok = await withSystem(async (db) => {
    // never re-send to a vendor that has since opted out of the channel or has no address
    const r = await db.query(
      `update notifications n set status='pending', attempts=0, last_error=null, failed_at=null, next_attempt_at=now(), locked_at=null
        from vendors v
       where n.id=$1 and n.status in ('failed','skipped') and v.id = n.vendor_id and n.recipient is not null
         and ((n.channel='email' and v.email_notifications) or (n.channel='whatsapp' and v.whatsapp_notifications))`, [id]);
    if (r.rowCount) await db.query("select write_audit('notification.requeue','notification',$1,null,null,$2,null,null,null,null)", [id, `Re-queued by ${user.fullName}`]);
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) throw new DomainError("INVALID_STATE", "Only failed or skipped notifications to opted-in recipients can be re-queued.", 409);
  void processNotificationQueue().catch(() => undefined);
  return { ok: true };
});
