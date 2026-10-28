import { api, STAFF } from "@/lib/http";
import { q, withUser } from "@/lib/db";

export const GET = api({ roles: STAFF }, async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Number(sp.get("limit") ?? 100) || 100, 500);
  const rows = await withUser(user.id, (db) => q<any>(db,
    `select a.id, a.chain_seq, a.created_at, a.actor_name, a.actor_role, a.action, a.entity_type, a.entity_id, a.summary, a.before, a.after, a.ip, r.rfq_number, v.vendor_code
       from audit_logs a left join rfqs r on r.id = a.rfq_id left join vendors v on v.id = a.vendor_id
      where ($1::uuid is null or a.rfq_id = $1) and ($2::text is null or a.entity_type = $2) and ($3::text is null or a.action ilike $3 || '%')
        and ($4::timestamptz is null or a.created_at >= $4) and ($5::timestamptz is null or a.created_at < $5)
        and ($6::bigint is null or a.id < $6) and ($7::text is null or a.actor_name ilike '%' || $7 || '%')
      order by a.id desc limit $8`,
    [sp.get("rfq") || null, sp.get("entity") || null, sp.get("action") || null, sp.get("from") || null, sp.get("to") || null, sp.get("before") || null, sp.get("actor") || null, limit]));
  return { rows, next: rows.length === limit ? rows[rows.length - 1].id : null };
});
