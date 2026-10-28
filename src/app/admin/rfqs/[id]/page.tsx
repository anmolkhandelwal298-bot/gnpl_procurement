import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { getInvitationsWithOffers, getRfq } from "@/lib/services/rfqs";
import { Card, DemoBadge, KV, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fmtDateTime, inr, mt } from "@/lib/format";
import { RfqActions } from "./actions";

export const dynamic = "force-dynamic";

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const { rfq, invites, allVendors, auction } = await withUser(user.id, async (db) => ({
    rfq: await getRfq(db, id), invites: await getInvitationsWithOffers(db, id),
    allVendors: await q<any>(db, "select id, vendor_code, legal_name, is_demo from vendors where status='approved' order by legal_name"),
    auction: (await q<any>(db, "select * from auctions where rfq_id=$1 and status<>'cancelled'", [id]))[0] ?? null,
  }));
  const invitedIds = new Set(invites.map((i) => i.vendor_id));
  return (
    <div className="space-y-5">
      <RfqActions rfqId={id} status={rfq.status} role={user.role} auctionId={auction?.id ?? null}
        candidates={allVendors.filter((v) => !invitedIds.has(v.id))} auctionStart={rfq.auction_start_at} auctionEnd={rfq.auction_end_at}
        qualified={invites.filter((i) => i.qualification_status === "qualified").length} pending={invites.filter((i) => i.offer_status === "submitted" && i.qualification_status === "pending").length} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Material specification" className="lg:col-span-2">
          <dl className="grid gap-4 sm:grid-cols-3">
            <KV label="Material">{rfq.material_name}</KV><KV label="Grade">{rfq.grade}</KV><KV label="Required quantity">{mt(rfq.required_qty_mt)} MT</KV>
            <KV label="Minimum GCV (ARB)">{rfq.min_gcv_arb} kcal/kg</KV><KV label="Max total moisture (ARB)">{rfq.max_moisture_pct}%</KV><KV label="Max ash">{rfq.max_ash_pct != null ? `${rfq.max_ash_pct}%` : "Not applicable"}</KV>
            <KV label="Origin">{rfq.origin}</KV><KV label="Other specifications">{rfq.other_specs}</KV><KV label="COA">{rfq.coa_required ? "Mandatory" : "Optional"}</KV>
            <KV label="Delivery location">{rfq.delivery_location}</KV><KV label="Delivery basis">{rfq.delivery_basis}</KV><KV label="Delivery schedule">{rfq.delivery_schedule}</KV>
            <KV label="Payment terms">{rfq.payment_terms}</KV><KV label="Document requirements">{rfq.doc_requirements}</KV><KV label="Additional conditions">{rfq.additional_terms}</KV>
          </dl>
        </Card>
        <Card title="Schedule & auction rules">
          <dl className="space-y-3">
            <KV label="Quotation window opens">{rfq.quotation_open_at ? fmtDateTime(rfq.quotation_open_at) : "On publication"}</KV>
            <KV label="Quotation deadline">{fmtDateTime(rfq.quotation_deadline)}</KV>
            <KV label="Auction"><span className="tabular">{fmtDateTime(auction?.start_at ?? rfq.auction_start_at)} → {fmtDateTime(auction?.end_at ?? rfq.auction_end_at)}</span></KV>
            <KV label="Minimum bid decrement"><span className="tabular">{inr(rfq.min_decrement)} / MT</span></KV>
            <KV label="Auto-extension">{rfq.ext_enabled ? `Bid within last ${rfq.ext_trigger_seconds}s → ${rfq.ext_duration_seconds}s remaining (max ${rfq.ext_max_count}×)` : "Disabled"}{auction?.extension_count ? ` · used ${auction.extension_count}×` : ""}</KV>
            <KV label="Compliance handling">{rfq.compliance_mode === "strict" ? "Strict — reject non-compliant quotations" : "Review — flag for qualification"}</KV>
            {rfq.status_reason && <KV label="Last status note">{rfq.status_reason}</KV>}
          </dl>
        </Card>
      </div>
      <Card title={`Invited vendors (${invites.length})`} pad={false}>
        <Table><thead><tr><Th>Vendor</Th><Th>Invitation</Th><Th>Quotation</Th><Th>Qualification</Th><Th>Contact</Th></tr></thead><tbody>
          {invites.map((i) => (
            <tr key={i.invitation_id}>
              <Td><span className="font-medium">{i.legal_name}</span>{i.is_demo && <DemoBadge />}<div className="text-xs text-navy-500">{i.vendor_code}</div></Td>
              <Td><StatusBadge status={i.invitation_status} /></Td>
              <Td>{i.offer_status ? <StatusBadge status={i.offer_status} /> : <span className="text-navy-400">none</span>}{i.submitted_at && <div className="text-xs text-navy-500">{fmtDateTime(i.submitted_at)}</div>}</Td>
              <Td>{i.qualification_status ? <StatusBadge status={i.qualification_status} /> : "—"}</Td>
              <Td className="text-xs text-navy-600">{i.contact_email}<br />{i.whatsapp_number ?? "no WhatsApp"}</Td>
            </tr>))}
          {!invites.length && <tr><Td colSpan={5} className="text-center text-navy-500">No vendors invited yet.</Td></tr>}
        </tbody></Table>
      </Card>
    </div>
  );
}
