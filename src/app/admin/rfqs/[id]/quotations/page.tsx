import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { getInvitationsWithOffers, getRfq } from "@/lib/services/rfqs";
import { QuotationReview } from "./review";

export const dynamic = "force-dynamic";
export default async function Quotations({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const { rfq, rows, docs } = await withUser(user.id, async (db) => ({
    rfq: await getRfq(db, id), rows: await getInvitationsWithOffers(db, id),
    docs: await q<any>(db, "select id, offer_id, doc_type, filename, size_bytes from offer_documents where rfq_id=$1 and removed_at is null order by created_at", [id]),
  }));
  return <QuotationReview rfq={JSON.parse(JSON.stringify(rfq))} rows={JSON.parse(JSON.stringify(rows))} docs={docs} canEdit={user.role !== "approver"} />;
}
