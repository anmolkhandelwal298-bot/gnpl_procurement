import { requireStaff } from "@/lib/auth/guards";
import { withUser } from "@/lib/db";
import { getWorksheet } from "@/lib/services/allocations";
import { Empty } from "@/components/ui";
import { Worksheet } from "./worksheet";

export const dynamic = "force-dynamic";
export default async function AllocationTab({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const ws = await withUser(user.id, (db) => getWorksheet(db, id));
  if (!ws) return <Empty>RFQ not found.</Empty>;
  if (!["closed", "awarded"].includes(ws.rfq.status)) {
    return <Empty>The allocation worksheet opens once the auction has closed. Current status: <b>{ws.rfq.status.replace(/_/g, " ")}</b>.</Empty>;
  }
  return <Worksheet rfqId={id} initial={JSON.parse(JSON.stringify(ws))} userId={user.id} role={user.role} />;
}
