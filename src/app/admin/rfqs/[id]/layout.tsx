import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/guards";
import { withUser } from "@/lib/db";
import { getRfq } from "@/lib/services/rfqs";
import { DemoBadge, StatusBadge } from "@/components/ui";
import { mt } from "@/lib/format";
import { RfqTabs } from "./tabs";

export default async function RfqLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const rfq = await withUser(user.id, (db) => getRfq(db, id));
  if (!rfq) notFound();
  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/rfqs" className="text-xs font-medium text-teal-700 hover:underline">← All RFQs</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-navy-900">{rfq.rfq_number}</h1><StatusBadge status={rfq.status} />{rfq.is_demo && <DemoBadge />}
        </div>
        <p className="text-sm text-navy-600">{rfq.material_name}{rfq.grade ? ` · ${rfq.grade}` : ""} · {mt(rfq.required_qty_mt)} MT · {rfq.delivery_basis} {rfq.delivery_location}</p>
      </div>
      <RfqTabs id={id} />
      {children}
    </div>
  );
}
