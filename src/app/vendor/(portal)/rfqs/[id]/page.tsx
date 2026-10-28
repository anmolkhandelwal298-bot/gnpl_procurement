import Link from "next/link";
import { notFound } from "next/navigation";
import { requireVendor } from "@/lib/auth/guards";
import { q1, withUser } from "@/lib/db";
import { getVendorRfq, markViewed } from "@/lib/services/offers";
import { buildSnapshot } from "@/lib/services/snapshot";
import { VendorRfqView } from "./view";

export const dynamic = "force-dynamic";
export default async function VendorRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireVendor();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || user.vendorStatus !== "approved") notFound();
  const data = await withUser(user.id, (db) => getVendorRfq(db, id));
  if (!data) notFound();
  if (data.invitation?.status === "invited") await markViewed(user.id, id);
  const award = await withUser(user.id, async (db) => (await q1<{ r: any }>(db, "select vendor_award_result($1) r", [id]))?.r ?? null);
  const snap = await buildSnapshot(user, id);
  return (
    <div className="space-y-4">
      <Link href="/vendor" className="text-xs font-medium text-teal-700 hover:underline">← My RFQs</Link>
      <VendorRfqView rfqId={id} data={JSON.parse(JSON.stringify(data))} award={award} initialSnap={JSON.parse(JSON.stringify(snap))} />
    </div>
  );
}
