import Link from "next/link";
import { requireStaff } from "@/lib/auth/guards";
import { q, q1, withUser } from "@/lib/db";
import { Card, DemoBadge, Empty, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fmtDateTime, mt } from "@/lib/format";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await requireStaff();
  const d = await withUser(user.id, async (db) => {
    const counts = await q<{ status: string; n: number }>(db, "select status, count(*)::int n from rfqs group by status");
    const pendingVendors = (await q1<{ n: number }>(db, "select count(*)::int n from vendors where status='pending'"))!.n;
    const awaitingApproval = await q<any>(db, "select r.id, r.rfq_number, r.material_name, a.total_allocated_mt, a.submitted_at from award_approvals a join rfqs r on r.id=a.rfq_id where a.status='submitted' order by a.submitted_at");
    const attention = await q<any>(db, `select id, rfq_number, material_name, status, required_qty_mt, quotation_deadline, auction_start_at, auction_end_at, is_demo from rfqs
       where status in ('quotation_open','qualification','scheduled','live','closed') order by case status when 'live' then 0 when 'closed' then 1 when 'qualification' then 2 when 'scheduled' then 3 else 4 end, auction_start_at limit 12`);
    const activity = await q<any>(db, "select created_at, actor_name, actor_role, action, entity_type, summary from audit_logs order by id desc limit 8");
    return { counts, pendingVendors, awaitingApproval, attention, activity };
  });
  const n = (s: string) => d.counts.find((c) => c.status === s)?.n ?? 0;
  const canApprove = user.role === "approver" || user.role === "admin";
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy-900">Overview</h1>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Quotations open" value={n("quotation_open")} sub="awaiting vendor submissions" />
        <Stat label="In qualification" value={n("qualification")} tone="amber" sub="technical review pending" />
        <Stat label="Live auctions" value={n("live")} sub={`${n("scheduled")} scheduled`} />
        <Stat label="Awaiting allocation" value={n("closed")} tone="navy" sub="auction closed" />
        <Stat label="Vendors to approve" value={d.pendingVendors} tone="amber" sub={<Link className="text-teal-700 hover:underline" href="/admin/vendors?status=pending">Review →</Link>} />
      </div>

      {canApprove && d.awaitingApproval.length > 0 && (
        <Card title="Awards awaiting your decision">
          <Table><thead><tr><Th>RFQ</Th><Th>Material</Th><Th>Allocated (MT)</Th><Th>Submitted</Th><Th /></tr></thead><tbody>
            {d.awaitingApproval.map((a: any) => (
              <tr key={a.rfq_number}><Td className="font-medium">{a.rfq_number}</Td><Td>{a.material_name}</Td><Td className="tabular">{mt(a.total_allocated_mt)}</Td><Td>{fmtDateTime(a.submitted_at)}</Td>
                <Td><Link className="font-semibold text-teal-700 hover:underline" href={`/admin/rfqs/${a.id}/allocation`}>Review →</Link></Td></tr>))}
          </tbody></Table>
        </Card>
      )}

      <Card title="Active procurement" actions={<Link className="text-sm font-semibold text-teal-700 hover:underline" href="/admin/rfqs">All RFQs →</Link>} pad={false}>
        {d.attention.length === 0 ? <div className="p-5"><Empty>No active RFQs. Create one from the RFQs page.</Empty></div> : (
          <Table><thead><tr><Th>RFQ</Th><Th>Material</Th><Th>Qty (MT)</Th><Th>Status</Th><Th>Quotation deadline</Th><Th>Auction</Th></tr></thead><tbody>
            {d.attention.map((r: any) => (
              <tr key={r.id} className="hover:bg-navy-50/50">
                <Td><Link className="font-semibold text-navy-700 hover:underline" href={`/admin/rfqs/${r.id}`}>{r.rfq_number}</Link>{r.is_demo && <DemoBadge />}</Td>
                <Td>{r.material_name}</Td><Td className="tabular">{mt(r.required_qty_mt)}</Td><Td><StatusBadge status={r.status} /></Td>
                <Td>{fmtDateTime(r.quotation_deadline)}</Td><Td>{fmtDateTime(r.auction_start_at)}</Td></tr>))}
          </tbody></Table>)}
      </Card>

      <Card title="Recent activity" actions={<Link className="text-sm font-semibold text-teal-700 hover:underline" href="/admin/audit">Audit log →</Link>} pad={false}>
        <Table><tbody>
          {d.activity.map((a: any, i: number) => (
            <tr key={i}><Td className="whitespace-nowrap text-navy-500">{fmtDateTime(a.created_at)}</Td><Td>{a.actor_name ?? "system"}</Td><Td className="font-mono text-xs">{a.action}</Td><Td className="text-navy-500">{a.summary}</Td></tr>))}
        </tbody></Table>
      </Card>
    </div>
  );
}
