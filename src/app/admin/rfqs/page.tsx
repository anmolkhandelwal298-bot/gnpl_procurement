import Link from "next/link";
import { requireStaff } from "@/lib/auth/guards";
import { listRfqs } from "@/lib/services/rfqs";
import { Card, DemoBadge, Empty, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fmtDateTime, mt } from "@/lib/format";

export const metadata = { title: "RFQs" };
export const dynamic = "force-dynamic";
const STATUSES = ["draft", "quotation_open", "qualification", "scheduled", "live", "closed", "awarded", "cancelled"];

export default async function RfqList({ searchParams }: { searchParams: Promise<{ status?: string; search?: string }> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const rfqs = await listRfqs(user.id, sp);
  const canCreate = user.role !== "approver";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-navy-900">Requests for quotation</h1>
        {canCreate && <Link href="/admin/rfqs/new" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">+ New RFQ</Link>}
      </div>
      <form className="flex flex-wrap gap-2" action="/admin/rfqs">
        <input name="search" defaultValue={sp.search} placeholder="Search RFQ number or material" className="w-72 max-w-full rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm" />
        <select name="status" defaultValue={sp.status ?? ""} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm">
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <button className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-semibold text-white">Filter</button>
        {(sp.search || sp.status) && <Link href="/admin/rfqs" className="px-2 py-2 text-sm text-navy-500 hover:underline">Clear</Link>}
      </form>
      <Card pad={false}>
        {rfqs.length === 0 ? <div className="p-5"><Empty>No RFQs match.</Empty></div> : (
          <Table><thead><tr><Th>RFQ</Th><Th>Material</Th><Th>Qty (MT)</Th><Th>Status</Th><Th>Vendors</Th><Th>Quotation deadline</Th><Th>Auction</Th></tr></thead><tbody>
            {rfqs.map((r) => (
              <tr key={r.id} className="hover:bg-navy-50/50">
                <Td><Link className="font-semibold text-navy-700 hover:underline" href={`/admin/rfqs/${r.id}`}>{r.rfq_number}</Link>{r.is_demo && <DemoBadge />}</Td>
                <Td>{r.material_name}{r.grade && <span className="text-navy-500"> · {r.grade}</span>}</Td>
                <Td className="tabular">{mt(r.required_qty_mt)}</Td><Td><StatusBadge status={r.status} /></Td>
                <Td className="tabular text-xs text-navy-600">{r.invited} invited · {r.submitted} quoted · {r.qualified} qualified</Td>
                <Td>{fmtDateTime(r.quotation_deadline)}</Td><Td>{fmtDateTime(r.auction_start_at)}</Td></tr>))}
          </tbody></Table>)}
      </Card>
    </div>
  );
}
