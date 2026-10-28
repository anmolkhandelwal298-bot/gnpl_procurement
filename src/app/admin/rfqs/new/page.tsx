import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { RfqForm } from "../rfq-form";

export const metadata = { title: "New RFQ" };
export default async function NewRfq() {
  const user = await requireStaff();
  if (user.role === "approver") redirect("/admin/rfqs");
  const vendors = await withUser(user.id, (db) => q<any>(db, "select id, vendor_code, legal_name, city, state, is_demo, whatsapp_number from vendors where status='approved' order by legal_name"));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy-900">New RFQ</h1>
      <RfqForm vendors={vendors} />
    </div>
  );
}
