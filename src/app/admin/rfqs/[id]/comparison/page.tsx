import { requireStaff } from "@/lib/auth/guards";
import { withUser } from "@/lib/db";
import { getComparisonMatrix } from "@/lib/services/auctions";
import { Matrix } from "./matrix";

export const dynamic = "force-dynamic";
export default async function ComparisonTab({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const rows = await withUser(user.id, (db) => getComparisonMatrix(db, id));
  return <Matrix rfqId={id} initial={JSON.parse(JSON.stringify(rows))} />;
}
