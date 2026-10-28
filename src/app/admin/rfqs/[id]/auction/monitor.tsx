"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { fmtCountdown, useAuctionStream, useCountdown } from "@/lib/use-auction-stream";
import { Alert, Badge, Button, Card, Empty, Field, Input, ReasonDialog, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fmtDateTime, fmtDateTimeSec, inr, mt, pct } from "@/lib/format";

const EVENT_LABEL: Record<string, string> = {
  bid_accepted: "Bid accepted", bid_rejected: "Bid rejected", auction_extended: "Auto-extended (late bid)", admin_extended: "Extended by admin", auction_opened: "Auction opened",
  auction_closed: "Auction closed", auction_scheduled: "Auction scheduled", auction_cancelled: "Auction cancelled", auction_rescheduled: "Auction rescheduled",
};

export function AdminAuctionMonitor({ rfqId, initial, canControl, role }: { rfqId: string; initial: any; canControl: boolean; role: string }) {
  const { snap, connected, now } = useAuctionStream<any>(rfqId, initial);
  const a = snap?.auction;
  const live = a?.status === "live" && Date.parse(a.end_at) > now();
  const target = !a ? null : a.status === "scheduled" && Date.parse(a.start_at) > now() ? a.start_at : a.status === "live" ? a.end_at : null;
  const remaining = useCountdown(target, now);
  const prev = useRef<Record<string, string>>({}); const [flash, setFlash] = useState<Record<string, boolean>>({});
  const [dlg, setDlg] = useState<null | "extend" | "close">(null); const [minutes, setMinutes] = useState("5"); const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!snap?.standings) return;
    const f: Record<string, boolean> = {};
    for (const s of snap.standings) { const key = `${s.current_price}|${s.rank}`; if (prev.current[s.vendor_id] && prev.current[s.vendor_id] !== key) f[s.vendor_id] = true; prev.current[s.vendor_id] = key; }
    if (Object.keys(f).length) { setFlash(f); const t = setTimeout(() => setFlash({}), 1800); return () => clearTimeout(t); }
  }, [snap]);

  if (!a) return <Empty>No auction has been scheduled for this RFQ yet.</Empty>;
  const statusLabel = a.status === "live" && !live ? "closing…" : a.status;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-navy-900 p-5 text-white shadow">
        <div>
          <div className="flex items-center gap-2"><StatusBadge status={a.status === "live" ? "live" : a.status} />
            <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-emerald-300" : "text-amber-300"}`}><span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} />{connected ? "Real-time connected" : "Reconnecting… (polling)"}</span></div>
          <div className="mt-2 text-sm text-navy-200">{fmtDateTime(a.start_at)} → {fmtDateTime(a.end_at)}{a.extension_count > 0 && <span className="ml-2 rounded bg-amber-400/20 px-2 py-0.5 text-amber-200">extended {a.extension_count}×</span>}</div>
          <div className="text-xs text-navy-300">Minimum decrement {inr(a.min_decrement)}/MT · auto-extension {a.ext_enabled ? `on (${a.ext_trigger_seconds}s window, max ${a.ext_max_count})` : "off"}</div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-navy-300">{a.status === "scheduled" ? "Starts in" : a.status === "live" ? "Time remaining" : statusLabel}</div>
          <div data-testid="admin-countdown" className="text-4xl font-bold tabular sm:text-5xl">{target ? fmtCountdown(remaining) : a.status === "closed" ? "CLOSED" : a.status.toUpperCase()}</div>
        </div>
      </div>

      {msg && <Alert tone="green">{msg}</Alert>}
      {canControl && ["scheduled", "live"].includes(a.status) && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDlg("extend")}>Extend end time</Button>
          {a.status === "live" && <Button variant="danger" onClick={() => setDlg("close")}>Close auction now</Button>}
        </div>)}
      {a.status === "closed" && <Alert tone="blue">Auction closed. <Link href={`/admin/rfqs/${rfqId}/comparison`} className="font-semibold underline">Open the comparison matrix</Link> or <Link href={`/admin/rfqs/${rfqId}/allocation`} className="font-semibold underline">go to allocation</Link>. Rank 1 is not an automatic award.</Alert>}

      <Card title="Live ranking — confidential, procurement only" pad={false}>
        <Table><thead><tr><Th>Rank</Th><Th>Vendor</Th><Th className="text-right">Latest FOR (₹/MT)</Th><Th className="text-right">Initial FOR</Th><Th className="text-right">Reduction</Th><Th className="text-right">Bids</Th><Th>Price set at</Th><Th className="text-right">Qty offered</Th></tr></thead><tbody>
          {snap.standings.map((s: any) => (
            <tr key={s.vendor_id} data-testid={`standing-${s.vendor_code}`} data-rank={s.rank} data-price={s.current_price} className={flash[s.vendor_id] ? "bg-teal-50 pop" : ""}>
              <Td><span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${s.rank === 1 ? "bg-teal-600 text-white" : "bg-navy-100 text-navy-700"}`}>{s.rank}</span></Td>
              <Td><span className="font-medium">{s.legal_name}</span><div className="text-xs text-navy-500">{s.vendor_code}</div></Td>
              <Td className="text-right text-base font-bold tabular">{inr(s.current_price)}</Td>
              <Td className="text-right tabular text-navy-600">{inr(s.initial_price)}</Td>
              <Td className="text-right tabular">{Number(s.reduction) > 0 ? <>{inr(s.reduction)} <span className="text-xs text-teal-700">({pct(s.reduction_pct)})</span></> : "—"}</Td>
              <Td className="text-right tabular">{s.bid_count}</Td><Td className="tabular text-xs">{fmtDateTimeSec(s.price_at)}</Td><Td className="text-right tabular">{mt(s.qty_offered_mt)} MT</Td>
            </tr>))}
          {!snap.standings.length && <tr><Td colSpan={8} className="text-center text-navy-500">No qualified vendors.</Td></tr>}
        </tbody></Table>
        <p className="border-t border-navy-50 px-4 py-2 text-xs text-navy-500">Ties are broken by the earliest time the price was reached, then bid sequence. Vendors see only their own price and rank.</p>
      </Card>

      <Card title="Bid &amp; auction events (newest first)" pad={false}>
        <div className="max-h-96 overflow-y-auto">
          <Table><thead><tr><Th>Server time</Th><Th>Event</Th><Th>Vendor</Th><Th>Detail</Th></tr></thead><tbody>
            {snap.events.map((e: any) => (
              <tr key={e.id}><Td className="whitespace-nowrap tabular text-xs">{fmtDateTimeSec(e.created_at)}</Td>
                <Td>{e.event_type === "bid_rejected" ? <Badge tone="red">{EVENT_LABEL[e.event_type]}</Badge> : e.event_type === "bid_accepted" ? <Badge tone="green">{EVENT_LABEL[e.event_type]}</Badge> : <Badge tone="blue">{EVENT_LABEL[e.event_type] ?? e.event_type}</Badge>}</Td>
                <Td>{e.legal_name ?? e.user_name ?? "system"}</Td>
                <Td className="text-xs text-navy-600">{detail(e)}</Td></tr>))}
            {!snap.events.length && <tr><Td colSpan={4} className="text-center text-navy-500">No events yet.</Td></tr>}
          </tbody></Table>
        </div>
      </Card>

      <ReasonDialog open={dlg === "extend"} onClose={() => setDlg(null)} title="Extend auction end time" confirmLabel="Extend"
        onConfirm={async (reason) => { await apiFetch(`/api/auctions/${a.id}/extend`, { body: { minutes: Number(minutes), reason } }); setMsg(`Extended by ${minutes} minutes.`); }}>
        <Field label="Extend by (minutes)"><Input type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field><div className="h-3" /></ReasonDialog>
      <ReasonDialog open={dlg === "close"} onClose={() => setDlg(null)} title="Close the auction now" danger confirmLabel="Close auction"
        onConfirm={async (reason) => { await apiFetch(`/api/auctions/${a.id}/close`, { body: { reason } }); setMsg("Auction closed."); }}><p className="mb-3 text-sm text-navy-600">No further bids will be accepted. This cannot be undone.</p></ReasonDialog>
    </div>
  );
}

function detail(e: any): string {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "bid_accepted": return `${inr(p.previous_amount)} → ${inr(p.amount)} (−${inr(Number(p.previous_amount) - Number(p.amount))})`;
    case "bid_rejected": return `${inr(p.attempted_amount)} — ${p.code}: ${p.message}`;
    case "auction_extended": return `${fmtDateTimeSec(p.previous_end_at)} → ${fmtDateTimeSec(p.new_end_at)} (#${p.extension_count})`;
    case "admin_extended": return `+${p.minutes} min — ${p.reason}`;
    case "auction_closed": return `${p.reason}${p.note ? ` — ${p.note}` : ""}`;
    case "auction_cancelled": return p.reason ?? "";
    case "auction_rescheduled": return p.reason ?? "";
    default: return "";
  }
}
