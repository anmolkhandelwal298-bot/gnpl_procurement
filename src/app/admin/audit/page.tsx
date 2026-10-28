import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { AuditTable } from "@/components/audit-table";
import { VerifyChain } from "./verify";

export const metadata = { title: "Audit & reports" };
export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ entity?: string; action?: string; actor?: string; from?: string; to?: string }> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const rows = await withUser(user.id, (db) => q<any>(db,
    `select a.id, a.chain_seq, a.created_at, a.actor_name, a.actor_role, a.action, a.entity_type, a.summary, a.before, a.after, a.ip, r.rfq_number
       from audit_logs a left join rfqs r on r.id = a.rfq_id
      where ($1::text is null or a.entity_type = $1) and ($2::text is null or a.action ilike $2 || '%') and ($3::text is null or a.actor_name ilike '%' || $3 || '%')
        and ($4::timestamptz is null or a.created_at >= $4) and ($5::timestamptz is null or a.created_at < $5)
      order by a.id desc limit 300`, [sp.entity || null, sp.action || null, sp.actor || null, sp.from || null, sp.to || null]));
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold text-navy-900">Audit trail &amp; reports</h1><VerifyChain /></div>
      <form className="flex flex-wrap gap-2" action="/admin/audit">
        <select name="entity" defaultValue={sp.entity ?? ""} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm"><option value="">All entities</option>
          {["rfq", "offer", "vendor", "invitation", "auction", "allocation", "award", "user", "document", "notification", "report", "audit"].map((e) => <option key={e}>{e}</option>)}</select>
        <input name="action" defaultValue={sp.action} placeholder="Action prefix, e.g. rfq." className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm" />
        <input name="actor" defaultValue={sp.actor} placeholder="Actor name" className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm" />
        <input type="date" name="from" defaultValue={sp.from} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm" />
        <input type="date" name="to" defaultValue={sp.to} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm" />
        <button className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-semibold text-white">Filter</button>
      </form>
      <AuditTable rows={JSON.parse(JSON.stringify(rows))} exportHref={`/api/audit/export?${qs || "all=1"}`} />
    </div>
  );
}
