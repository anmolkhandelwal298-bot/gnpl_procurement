import Link from "next/link";
import { requireVendor } from "@/lib/auth/guards";
import { listVendorRfqs } from "@/lib/services/offers";
import { Alert, Card, DemoBadge, Empty, StatusBadge } from "@/components/ui";
import { fmtDateTime, mt } from "@/lib/format";

export const metadata = { title: "My RFQs" };
export const dynamic = "force-dynamic";

export default async function VendorHome() {
  const user = await requireVendor();
  const rfqs = user.vendorStatus === "approved" ? await listVendorRfqs(user.id) : [];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-navy-900">Requests for quotation</h1>
      {user.vendorStatus === "pending" && <Alert tone="amber"><b>Your registration is awaiting approval.</b> Grainspan procurement is verifying your company. You will be able to receive RFQ invitations once approved.</Alert>}
      {user.vendorStatus === "rejected" && <Alert>Your registration was not approved. Please contact Grainspan procurement.</Alert>}
      {user.vendorStatus === "suspended" && <Alert>Your account is suspended. Please contact Grainspan procurement.</Alert>}
      {user.vendorStatus === "approved" && rfqs.length === 0 && <Empty>You have not been invited to any RFQ yet. Invitations arrive by e-mail and WhatsApp and appear here.</Empty>}
      <div className="grid gap-4">
        {rfqs.map((r) => (
          <Link key={r.id} href={`/vendor/rfqs/${r.id}`} className="block">
            <Card className="transition hover:border-teal-400 hover:shadow-md">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex items-center gap-2"><span className="text-lg font-bold text-navy-900">{r.rfq_number}</span>{r.is_demo && <DemoBadge />}</div>
                  <p className="text-sm text-navy-600">{r.material_name}{r.grade ? ` · ${r.grade}` : ""} · {mt(r.required_qty_mt)} MT</p></div>
                <div className="flex flex-wrap gap-1.5"><StatusBadge status={r.status} />
                  {r.invitation_status === "declined" ? <StatusBadge status="declined" /> : r.offer_status ? <StatusBadge status={r.offer_status === "submitted" ? "submitted" : r.offer_status} /> : r.status === "quotation_open" ? <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">Quotation due</span> : null}</div>
              </div>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs uppercase tracking-wide text-navy-500">Quotation deadline</dt><dd className="font-medium">{fmtDateTime(r.quotation_deadline)}</dd></div>
                <div><dt className="text-xs uppercase tracking-wide text-navy-500">Live auction</dt><dd className="font-medium">{fmtDateTime(r.auction_start_at)}</dd></div>
              </dl>
            </Card>
          </Link>))}
      </div>
    </div>
  );
}
