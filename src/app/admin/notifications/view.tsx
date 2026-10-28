"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { Alert, Badge, Button, Card, Empty, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fmtDateTimeSec } from "@/lib/format";
import { KIND_LABEL, type NotifKind } from "@/lib/notify/templates";

export function NotificationsView({ providers, rows, counts, sp, canRequeue }: { providers: any; rows: any[]; counts: any[]; sp: { status?: string; channel?: string }; canRequeue: boolean }) {
  const router = useRouter();
  const n = (ch: string, st: string) => counts.find((c) => c.channel === ch && c.status === st)?.n ?? 0;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-navy-900">Notification delivery</h1>
      <div className="grid gap-4 md:grid-cols-2">
        {([["email", "E-mail"], ["whatsapp", "WhatsApp"]] as const).map(([ch, label]) => {
          const p = providers[ch];
          return (
            <Card key={ch} title={label} actions={p.configured ? <Badge tone="green">Provider configured</Badge> : <Badge tone="red">Not configured</Badge>}>
              <p className="text-sm text-navy-600">{p.provider}</p>
              {!p.configured && <div className="mt-2"><Alert tone="amber">Missing environment variable(s): <code className="font-mono">{p.missing.join(", ")}</code>. Messages are recorded as <b>skipped</b> until configured — see docs/NOTIFICATIONS.md.</Alert></div>}
              {p.configured && !p.webhook && <p className="mt-2 text-xs text-amber-700">Delivery-receipt webhook not configured: messages will show “sent” but never “delivered”.</p>}
              <div className="mt-3 flex flex-wrap gap-3 text-sm tabular">
                {["pending", "sent", "delivered", "failed", "skipped"].map((s) => <span key={s} className="flex items-center gap-1.5"><StatusBadge status={s} /> {n(ch, s)}</span>)}
              </div>
            </Card>);
        })}
      </div>
      <form className="flex flex-wrap gap-2" action="/admin/notifications">
        <select name="channel" defaultValue={sp.channel ?? ""} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm"><option value="">All channels</option><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option></select>
        <select name="status" defaultValue={sp.status ?? ""} className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm"><option value="">All statuses</option>{["pending", "sent", "delivered", "failed", "skipped"].map((s) => <option key={s}>{s}</option>)}</select>
        <button className="rounded-lg bg-navy-800 px-4 py-2 text-sm font-semibold text-white">Filter</button><Link href="/admin/notifications" className="px-2 py-2 text-sm text-navy-500 hover:underline">Clear</Link>
      </form>
      {rows.length === 0 ? <Empty>No notifications yet.</Empty> : (
        <Card pad={false}><Table><thead><tr><Th>Created</Th><Th>Type</Th><Th>RFQ</Th><Th>Vendor</Th><Th>Channel / recipient</Th><Th>Status</Th><Th>Attempts</Th><Th>Detail</Th>{canRequeue && <Th />}</tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.id}><Td className="whitespace-nowrap text-xs tabular">{fmtDateTimeSec(r.created_at)}</Td><Td className="text-xs">{KIND_LABEL[r.kind as NotifKind] ?? r.kind}</Td><Td className="text-xs">{r.rfq_number}</Td>
              <Td className="text-xs">{r.legal_name}<div className="text-navy-500">{r.vendor_code}</div></Td><Td className="text-xs"><b>{r.channel}</b><div className="text-navy-500">{r.recipient ?? "—"}</div></Td>
              <Td><StatusBadge status={r.status} />{r.delivered_at && <div className="text-xs text-navy-500">{fmtDateTimeSec(r.delivered_at)}</div>}</Td>
              <Td className="tabular text-xs">{r.attempts}/{r.max_attempts}{r.status === "pending" && r.next_attempt_at && <div className="text-navy-500">next {fmtDateTimeSec(r.next_attempt_at)}</div>}</Td>
              <Td className="max-w-xs text-xs text-red-700">{r.last_error}</Td>
              {canRequeue && <Td>{["failed", "skipped"].includes(r.status) && <Button size="sm" variant="secondary" onClick={async () => { try { await apiFetch(`/api/notifications/${r.id}/requeue`, { body: {} }); router.refresh(); } catch (e: any) { alert(e.message); } }}>Retry</Button>}</Td>}
            </tr>))}
        </tbody></Table></Card>)}
    </div>
  );
}
