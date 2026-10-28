import { requireStaff } from "@/lib/auth/guards";
import { q, withUser } from "@/lib/db";
import { providerStatus } from "@/lib/notify/config";
import { NotificationsView } from "./view";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string; channel?: string }> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const rows = await withUser(user.id, (db) => q<any>(db,
    `select n.id, n.kind, n.channel, n.status, n.attempts, n.max_attempts, n.recipient, n.last_error, n.sent_at, n.delivered_at, n.next_attempt_at, n.created_at, r.rfq_number, v.vendor_code, v.legal_name
       from notifications n left join rfqs r on r.id = n.rfq_id left join vendors v on v.id = n.vendor_id
      where ($1::text is null or n.status::text = $1) and ($2::text is null or n.channel::text = $2) order by n.created_at desc limit 300`, [sp.status || null, sp.channel || null]));
  const counts = await withUser(user.id, (db) => q<any>(db, "select channel, status, count(*)::int n from notifications group by 1,2"));
  return <NotificationsView providers={providerStatus()} rows={JSON.parse(JSON.stringify(rows))} counts={counts} sp={sp} canRequeue={user.role !== "approver"} />;
}
