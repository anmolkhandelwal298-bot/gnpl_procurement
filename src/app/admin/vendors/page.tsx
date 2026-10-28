import { requireStaff } from "@/lib/auth/guards";
import { listVendors } from "@/lib/services/vendors";
import { VendorTable } from "./vendor-table";

export const metadata = { title: "Vendors" };
export const dynamic = "force-dynamic";
export default async function VendorsPage({ searchParams }: { searchParams: Promise<{ status?: string; search?: string }> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const vendors = await listVendors(user.id, sp);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-navy-900">Vendor directory</h1>
      <form className="flex flex-wrap gap-2" action="/admin/vendors">
        <input name="search" defaultValue={sp.search} placeholder="Search name, ID, e-mail, GSTIN" className="w-72 max-w-full rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm" />
        <select name="status" defaultValue={sp.status ?? ""} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm">
          <option value="">All statuses</option>{["pending", "approved", "suspended", "rejected"].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <button className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-semibold text-white">Filter</button>
      </form>
      <VendorTable vendors={JSON.parse(JSON.stringify(vendors))} canEdit={user.role !== "approver"} />
    </div>
  );
}
