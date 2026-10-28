import { q, withSystem } from "../db";
import { sendEmail, type SendResult } from "./email";
import { sendWhatsAppTemplate } from "./whatsapp";
import { renderEmail, whatsappTemplate, type NotifKind, type NotifPayload } from "./templates";

const BACKOFF_MINUTES = [1, 5, 30, 120, 360];

interface Row { id: string; kind: NotifKind; channel: "email" | "whatsapp"; recipient: string | null; payload: NotifPayload; attempts: number; max_attempts: number }

/**
 * Claims due notifications (FOR UPDATE SKIP LOCKED so several instances never double-send), calls the real provider API outside any
 * DB transaction, then records the outcome. Statuses: pending → sent → delivered (webhook) | failed | skipped (not configured / opted out).
 */
export async function processNotificationQueue(limit = 25): Promise<{ claimed: number; sent: number; failed: number; retrying: number; skipped: number }> {
  const stats = { claimed: 0, sent: 0, failed: 0, retrying: 0, skipped: 0 };
  const rows = await withSystem(async (db) => {
    await db.query("update notifications set status='pending', locked_at=null where status='processing' and locked_at < now() - interval '5 minutes'");
    return q<Row>(db,
      `with c as (select id from notifications where status = 'pending' and next_attempt_at <= now() order by next_attempt_at limit $1 for update skip locked)
       update notifications n set status = 'processing', locked_at = now(), attempts = n.attempts + 1
         from c where n.id = c.id returning n.id, n.kind, n.channel, n.recipient, n.payload, n.attempts, n.max_attempts`, [limit]);
  });
  stats.claimed = rows.length;
  for (const r of rows) {
    let res: SendResult;
    try {
      if (!r.recipient) res = { ok: false, retryable: false, error: "No recipient" };
      else if (r.channel === "email") {
        const m = renderEmail(r.kind, r.payload);
        res = await sendEmail(r.recipient, m.subject, m.html, m.text, r.id);
      } else {
        const t = whatsappTemplate(r.kind, r.payload);
        res = await sendWhatsAppTemplate(r.recipient, t.name, t.params);
      }
    } catch (e: any) {
      res = { ok: false, retryable: true, error: `Unexpected error: ${e?.message ?? e}` };
    }
    await withSystem(async (db) => {
      if (res.ok) {
        stats.sent++;
        await db.query("update notifications set status='sent', sent_at=now(), provider_message_id=$2, last_error=null, locked_at=null, next_attempt_at=null where id=$1", [r.id, res.messageId]);
      } else if ("notConfigured" in res) {
        stats.skipped++;
        await db.query("update notifications set status='skipped', last_error=$2, locked_at=null, next_attempt_at=null where id=$1", [r.id, res.error]);
      } else if (!res.retryable || r.attempts >= r.max_attempts) {
        stats.failed++;
        await db.query("update notifications set status='failed', failed_at=now(), last_error=$2, locked_at=null, next_attempt_at=null where id=$1", [r.id, res.error]);
      } else {
        stats.retrying++;
        const mins = BACKOFF_MINUTES[Math.min(r.attempts - 1, BACKOFF_MINUTES.length - 1)];
        await db.query("update notifications set status='pending', last_error=$2, locked_at=null, next_attempt_at = now() + ($3 || ' minutes')::interval where id=$1", [r.id, res.error, String(mins)]);
      }
    });
  }
  return stats;
}

/** Admin action: re-queue a failed or skipped notification as a brand-new attempt chain. */
export async function requeueNotification(id: string): Promise<boolean> {
  return withSystem(async (db) => {
    const r = await db.query(
      `update notifications set status='pending', attempts=0, last_error=null, failed_at=null, next_attempt_at=now(), locked_at=null
        where id=$1 and status in ('failed','skipped')`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
