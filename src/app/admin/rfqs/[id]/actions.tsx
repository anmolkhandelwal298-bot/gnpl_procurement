"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Alert, Button, Card, DemoBadge, Field, Input, Modal, ReasonDialog } from "@/components/ui";
import { toLocalInput } from "@/lib/format";

type Candidate = { id: string; vendor_code: string; legal_name: string; is_demo: boolean };

export function RfqActions({ rfqId, status, role, auctionId, candidates, auctionStart, auctionEnd, qualified, pending }: {
  rfqId: string; status: string; role: string; auctionId: string | null; candidates: Candidate[]; auctionStart: string | null; auctionEnd: string | null; qualified: number; pending: number;
}) {
  const router = useRouter();
  const [dlg, setDlg] = useState<null | "cancel" | "close-q" | "reopen" | "invite" | "schedule" | "reschedule" | "extend" | "closeNow">(null);
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [start, setStart] = useState(toLocalInput(auctionStart)); const [end, setEnd] = useState(toLocalInput(auctionEnd)); const [minutes, setMinutes] = useState("10");
  const [fe, setFe] = useState<Record<string, string>>({});
  const done = (text: string) => { setMsg({ tone: "green", text }); setDlg(null); router.refresh(); };
  const fail = (e: any) => { setMsg({ tone: "red", text: e.message }); setFe(e.fields ?? {}); };
  const call = async (path: string, body: unknown = {}) => { setBusy(true); setMsg(null); setFe({}); try { return await apiFetch(path, { body }); } catch (e) { fail(e); throw e; } finally { setBusy(false); } };
  const editor = role === "admin" || role === "procurement_manager";
  if (!editor) return null;
  const st = status;

  return (
    <Card title="Actions">
      {msg && <div className="mb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <div className="flex flex-wrap gap-2">
        {st === "draft" && <>
          <Link href={`/admin/rfqs/${rfqId}/edit`} className="rounded-lg border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-800 hover:bg-navy-50">Edit draft</Link>
          <Button busy={busy} onClick={async () => { if (!confirm("Publish this RFQ and notify the invited vendors by e-mail and WhatsApp?")) return; try { const r: any = await call(`/api/rfqs/${rfqId}/publish`); done(`Published. ${r.invited} vendors invited; ${r.notificationsQueued} notifications queued (see Notifications for delivery status).`); } catch { /* shown */ } }}>Publish & notify vendors</Button></>}
        {["published", "quotation_open"].includes(st) && <>
          <Link href={`/admin/rfqs/${rfqId}/edit`} className="rounded-lg border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-800 hover:bg-navy-50">Adjust schedule</Link>
          <Button variant="secondary" onClick={() => { setSel([]); setDlg("invite"); }}>Invite more vendors</Button>
          <Button variant="secondary" onClick={() => setDlg("close-q")}>Close quotations now</Button></>}
        {st === "qualification" && <>
          <Link href={`/admin/rfqs/${rfqId}/quotations`} className="rounded-lg border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-800 hover:bg-navy-50">Review quotations ({pending} pending)</Link>
          <Button disabled={pending > 0 || qualified < 1} onClick={() => setDlg("schedule")}>Schedule auction</Button>
          {(pending > 0 || qualified < 1) && <span className="self-center text-xs text-navy-500">{pending > 0 ? `Decide all ${pending} pending quotation(s) first.` : "Qualify at least one vendor."}</span>}</>}
        {st === "scheduled" && <>
          <Button variant="secondary" onClick={() => setDlg("reschedule")}>Reschedule</Button>
          <Button variant="secondary" onClick={() => setDlg("extend")}>Extend end time</Button>
          <Button variant="secondary" onClick={() => setDlg("reopen")}>Reopen qualification</Button></>}
        {st === "live" && <>
          <Link href={`/admin/rfqs/${rfqId}/auction`} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Open live monitor</Link>
          <Button variant="secondary" onClick={() => setDlg("extend")}>Extend</Button>
          <Button variant="danger" onClick={() => setDlg("closeNow")}>Close auction now</Button>
          {role === "admin" && <Button variant="secondary" onClick={() => setDlg("reopen")}>Cancel auction & reopen qualification</Button>}</>}
        {st === "closed" && <Link href={`/admin/rfqs/${rfqId}/allocation`} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Go to allocation worksheet</Link>}
        {!["awarded", "cancelled"].includes(st) && !(st === "live" && role !== "admin") && <Button variant="ghost" className="text-red-700" onClick={() => setDlg("cancel")}>Cancel RFQ</Button>}
        {["awarded", "cancelled"].includes(st) && <span className="text-sm text-navy-500">This RFQ is {st}; no further actions.</span>}
      </div>

      <ReasonDialog open={dlg === "cancel"} onClose={() => setDlg(null)} title="Cancel this RFQ" danger confirmLabel="Cancel RFQ"
        onConfirm={async (reason) => { await call(`/api/rfqs/${rfqId}/cancel`, { reason }); done("RFQ cancelled."); }}><p className="mb-3 text-sm text-navy-600">Cancelling is permanent. Any scheduled or live auction is cancelled; bids already placed are preserved in the record.</p></ReasonDialog>
      <ReasonDialog open={dlg === "close-q"} onClose={() => setDlg(null)} title="Close quotations early" confirmLabel="Close quotations"
        onConfirm={async (reason) => { await call(`/api/rfqs/${rfqId}/close-quotations`, { reason }); done("Quotation window closed; RFQ moved to qualification."); }}><p className="mb-3 text-sm text-navy-600">Vendors will no longer be able to submit or change quotations.</p></ReasonDialog>
      <ReasonDialog open={dlg === "reopen"} onClose={() => setDlg(null)} title={st === "live" ? "Cancel the live auction and reopen qualification" : "Reopen qualification"} danger={st === "live"} confirmLabel="Reopen qualification"
        onConfirm={async (reason) => { await call(`/api/rfqs/${rfqId}/reopen-qualification`, { reason }); done("Qualification reopened. The auction was cancelled; its bids remain on record."); }}>
        <p className="mb-3 text-sm text-navy-600">The current auction is cancelled (bid history is kept) and the RFQ returns to qualification. You can then allow individual vendors to revise their technical data and schedule a new auction.</p></ReasonDialog>
      <ReasonDialog open={dlg === "extend"} onClose={() => setDlg(null)} title="Extend auction end time" confirmLabel="Extend"
        onConfirm={async (reason) => { await call(`/api/auctions/${auctionId}/extend`, { minutes: Number(minutes), reason }); done(`Auction extended by ${minutes} minutes.`); }}>
        <Field label="Extend by (minutes)"><Input type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field><div className="h-3" /></ReasonDialog>
      <ReasonDialog open={dlg === "closeNow"} onClose={() => setDlg(null)} title="Close the auction now" danger confirmLabel="Close auction"
        onConfirm={async (reason) => { await call(`/api/auctions/${auctionId}/close`, { reason }); done("Auction closed. Proceed to allocation."); }}><p className="mb-3 text-sm text-navy-600">No further bids will be accepted. This cannot be undone.</p></ReasonDialog>

      <Modal open={dlg === "invite"} onClose={() => setDlg(null)} title="Invite more vendors">
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {candidates.map((v) => (
            <label key={v.id} className="flex items-center gap-2 rounded-lg border border-navy-100 px-3 py-2 text-sm"><input type="checkbox" checked={sel.includes(v.id)} onChange={() => setSel(sel.includes(v.id) ? sel.filter((x) => x !== v.id) : [...sel, v.id])} />{v.legal_name}{v.is_demo && <DemoBadge />}<span className="text-xs text-navy-500">{v.vendor_code}</span></label>))}
          {!candidates.length && <p className="text-sm text-navy-500">All approved vendors are already invited.</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
          <Button busy={busy} disabled={!sel.length} onClick={async () => { try { await call(`/api/rfqs/${rfqId}/invite`, { vendorIds: sel }); done(`${sel.length} vendor(s) invited and notified.`); } catch { /* shown */ } }}>Invite & notify</Button></div>
      </Modal>
      <Modal open={dlg === "schedule" || dlg === "reschedule"} onClose={() => setDlg(null)} title={dlg === "schedule" ? "Schedule the live auction" : "Reschedule the auction"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Auction start" error={fe.startAt}><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Auction end" error={fe.endAt}><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        {dlg === "reschedule" && <p className="mt-2 text-xs text-navy-500">The change is recorded in the audit log.</p>}
        <p className="mt-3 text-sm text-navy-600">{qualified} qualified vendor(s) will be able to bid. Technical data and quantities are locked from this point.</p>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
          <Button busy={busy} onClick={async () => {
            try {
              if (dlg === "schedule") await call(`/api/rfqs/${rfqId}/schedule`, { startAt: start, endAt: end });
              else await call(`/api/auctions/${auctionId}/reschedule`, { startAt: start, endAt: end, reason: "Rescheduled by procurement" });
              done("Auction scheduled.");
            } catch { /* shown */ }
          }}>{dlg === "schedule" ? "Schedule" : "Save"}</Button></div>
      </Modal>
    </Card>
  );
}
