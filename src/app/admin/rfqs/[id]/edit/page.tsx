import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { getRfq } from "@/lib/services/rfqs";
import { toLocalInput } from "@/lib/format";
import { RfqForm, type RfqFormValues } from "../../rfq-form";

export const metadata = { title: "Edit RFQ" };
export default async function EditRfq({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  if (user.role === "approver") redirect(`/admin/rfqs/${id}`);
  const { rfq, vendors, invited } = await withUser(user.id, async (db) => ({
    rfq: await getRfq(db, id),
    vendors: await q<any>(db, "select id, vendor_code, legal_name, city, state, is_demo from vendors where status='approved' order by legal_name"),
    invited: (await q<{ vendor_id: string }>(db, "select vendor_id from rfq_invitations where rfq_id=$1", [id])).map((r) => r.vendor_id),
  }));
  if (!rfq || ["closed", "awarded", "cancelled", "live"].includes(rfq.status)) redirect(`/admin/rfqs/${id}`);
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const initial: Partial<RfqFormValues> = {
    materialName: rfq.material_name, grade: s(rfq.grade), requiredQtyMt: s(rfq.required_qty_mt), minGcvArb: s(rfq.min_gcv_arb), maxMoisturePct: s(rfq.max_moisture_pct), maxAshPct: s(rfq.max_ash_pct),
    origin: s(rfq.origin), otherSpecs: s(rfq.other_specs), deliveryLocation: rfq.delivery_location, deliveryBasis: rfq.delivery_basis, deliverySchedule: s(rfq.delivery_schedule),
    paymentTerms: s(rfq.payment_terms), quotationOpenAt: toLocalInput(rfq.quotation_open_at), quotationDeadline: toLocalInput(rfq.quotation_deadline),
    auctionStartAt: toLocalInput(rfq.auction_start_at), auctionEndAt: toLocalInput(rfq.auction_end_at), minDecrement: s(rfq.min_decrement), extEnabled: rfq.ext_enabled,
    extTriggerSeconds: s(rfq.ext_trigger_seconds), extDurationSeconds: s(rfq.ext_duration_seconds), extMaxCount: s(rfq.ext_max_count), coaRequired: rfq.coa_required,
    docRequirements: s(rfq.doc_requirements), additionalTerms: s(rfq.additional_terms), complianceMode: rfq.compliance_mode, invitedVendorIds: invited,
  };
  return <RfqForm vendors={vendors} initial={initial} rfqId={id} status={rfq.status} />;
}
