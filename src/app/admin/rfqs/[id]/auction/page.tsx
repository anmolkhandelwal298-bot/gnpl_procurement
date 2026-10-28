import { requireStaff } from "@/lib/auth/guards";
import { buildSnapshot } from "@/lib/services/snapshot";
import { AdminAuctionMonitor } from "./monitor";

export const dynamic = "force-dynamic";
export default async function AuctionTab({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const snap = await buildSnapshot(user, id);
  return <AdminAuctionMonitor rfqId={id} initial={JSON.parse(JSON.stringify(snap))} canControl={user.role !== "approver"} role={user.role} />;
}
