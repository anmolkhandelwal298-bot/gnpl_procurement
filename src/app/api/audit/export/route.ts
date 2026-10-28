import { api, STAFF } from "@/lib/http";
import { q, withUser } from "@/lib/db";
import { fileResponse, toCsv, toXlsx } from "@/lib/reports";
import { fmtDateTimeSec } from "@/lib/format";

export const GET = api({ roles: STAFF, limit: { name: "audit-export", max: 10, windowSec: 60 } }, async ({ req, user, ip }) => {
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  return withUser(user.id, async (db) => {
    const rows = await q<any>(db,
      `select a.chain_seq, a.created_at, a.actor_name, a.actor_role, a.action, a.entity_type, a.entity_id, r.rfq_number, v.vendor_code, a.summary, a.before, a.after, a.ip, a.row_hash
         from audit_logs a left join rfqs r on r.id = a.rfq_id left join vendors v on v.id = a.vendor_id
        where ($1::uuid is null or a.rfq_id = $1) and ($2::timestamptz is null or a.created_at >= $2) and ($3::timestamptz is null or a.created_at < $3)
          and ($4::text is null or a.entity_type = $4) and ($5::text is null or a.action ilike $5 || '%') and ($6::text is null or a.actor_name ilike '%' || $6 || '%')
        order by a.chain_seq limit 20000`, [sp.get("rfq") || null, sp.get("from") || null, sp.get("to") || null, sp.get("entity") || null, sp.get("action") || null, sp.get("actor") || null]);
    await db.query("select write_audit('report.export','audit',null,$1,null,$2,null,null,null,$3)", [sp.get("rfq") || null, `Exported audit log (${rows.length} rows)`, ip]);
    const headers = ["Seq", "Time", "Actor", "Role", "Action", "Entity", "Entity ID", "RFQ", "Vendor", "Summary", "Before", "After", "IP", "Row hash"];
    const data = rows.map((r) => [Number(r.chain_seq), fmtDateTimeSec(r.created_at), r.actor_name, r.actor_role, r.action, r.entity_type, r.entity_id, r.rfq_number, r.vendor_code,
      r.summary, r.before ? JSON.stringify(r.before) : "", r.after ? JSON.stringify(r.after) : "", r.ip, r.row_hash]);
    return fileResponse(format, "audit-log", format === "csv" ? toCsv(headers, data) : await toXlsx("Audit log", headers, data));
  });
});
