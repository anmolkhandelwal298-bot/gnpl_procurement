import { api, STAFF } from "@/lib/http";
import { q, withUser } from "@/lib/db";
import { providerStatus } from "@/lib/notify/config";

export const GET = api({ roles: STAFF }, async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const rows = await withUser(user.id, (db) => q<any>(db,
    `select n.id, n.kind, n.channel, n.status, n.attempts, n.max_attempts, n.recipient, n.last_error, n.provider_message_id, n.sent_at, n.delivered_at, n.failed_at,
            n.next_attempt_at, n.created_at, r.rfq_number, v.vendor_code, v.legal_name
       from notifications n left join rfqs r on r.id = n.rfq_id left join vendors v on v.id = n.vendor_id
      where ($1::uuid is null or n.rfq_id = $1) and ($2::text is null or n.status::text = $2) and ($3::text is null or n.channel::text = $3)
      order by n.created_at desc limit 300`, [sp.get("rfq") || null, sp.get("status") || null, sp.get("channel") || null]));
  return { providers: providerStatus(), rows };
});
