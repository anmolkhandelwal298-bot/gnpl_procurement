import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { AuditTable } from "@/components/audit-table";

export const dynamic = "force-dynamic";
export default async function RfqAudit({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const rows = await withUser(user.id, (db) => q<any>(db,
    `select a.id, a.chain_seq, a.created_at, a.actor_name, a.actor_role, a.action, a.entity_type, a.summary, a.before, a.after, a.ip from audit_logs a where a.rfq_id=$1 order by a.id desc limit 300`, [id]));
  return <AuditTable rows={JSON.parse(JSON.stringify(rows))} exportHref={`/api/audit/export?rfq=${id}`} />;
}
