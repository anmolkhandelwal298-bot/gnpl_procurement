"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Badge, Button, Card, Field, Input, Modal, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { fmtDateTime, inr, mt } from "@/lib/format";

export function Worksheet({ rfqId, initial, userId, role }: { rfqId: string; initial: any; userId: string; role: string }) {
  const router = useRouter();
  const ws = initial;
  const cur = ws.current as any | null;
  const required = Number(ws.rfq.required_qty_mt);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(ws.lines.map((l: any) => [l.vendor_id, Number(l.allocated_qty_mt) ? String(Number(l.allocated_qty_mt)) : ""])));
  const [rem, setRem] = useState<Record<string, string>>(() => Object.fromEntries(ws.lines.map((l: any) => [l.vendor_id, l.remarks ?? ""])));
  const [serverErr, setServerErr] = useState<Record<string, string>>({}); const [msg, setMsg] = useState<{ tone: "red" | "green"; t: string } | null>(null);
  const [busy, setBusy] = useState(""); const [dlg, setDlg] = useState<null | "submit" | "reject" | "approve">(null); const [remarks, setRemarks] = useState("");
  const editor = role === "admin" || role === "procurement_manager";
  const decider = role === "admin" || role === "approver";
  const editable = ws.rfq.status === "closed" && editor && (!cur || ["draft", "rejected"].includes(cur.status));

  const calc = useMemo(() => {
    const errs: Record<string, string> = {}; let total = 0, value = 0;
    for (const l of ws.lines) {
      const raw = qty[l.vendor_id] ?? ""; const n = raw === "" ? 0 : Number(raw);
      if (Number.isNaN(n)) errs[l.vendor_id] = "Enter a number";
      else if (n < 0) errs[l.vendor_id] = "Cannot be negative";
      else if (n > 0 && l.qualification_status !== "qualified") errs[l.vendor_id] = "Vendor is not qualified";
      else if (n > Number(l.qty_offered_mt)) errs[l.vendor_id] = `Exceeds offered ${mt(l.qty_offered_mt)} MT`;
      else if (!/^\d*(\.\d{0,3})?$/.test(raw)) errs[l.vendor_id] = "Max 3 decimals";
      if (!Number.isNaN(n)) { total += n; value += n * Number(l.current_price); }
    }
    const over = total > required + 1e-9;
    return { errs, total, value, over, remaining: required - total, invalid: Object.keys(errs).length > 0 || over };
  }, [qty, ws.lines, required]);

  const save = async (): Promise<boolean> => {
    setBusy("save"); setMsg(null); setServerErr({});
    try {
      await apiFetch(`/api/rfqs/${rfqId}/allocations`, { method: "PUT", body: { lines: ws.lines.map((l: any) => ({ vendorId: l.vendor_id, qty: qty[l.vendor_id] === "" || qty[l.vendor_id] === undefined ? "0" : qty[l.vendor_id], remarks: rem[l.vendor_id] || null })) } });
      setMsg({ tone: "green", t: "Draft allocation saved." }); router.refresh(); return true;
    } catch (x) { const a = x as ApiError; setServerErr(a.fields); setMsg({ tone: "red", t: a.fields?._total ?? a.message }); return false; } finally { setBusy(""); }
  };
  const act = async (name: string, path: string, body: unknown, ok: string) => {
    setBusy(name); setMsg(null);
    try { await apiFetch(path, { body }); setMsg({ tone: "green", t: ok }); setDlg(null); setRemarks(""); router.refresh(); }
    catch (x: any) { setMsg({ tone: "red", t: x.message }); } finally { setBusy(""); }
  };
  const selfSubmitted = cur?.submitted_by === userId;

  return (
    <div className="space-y-5">
      {ws.rfq.status === "awarded" && <Alert tone="green"><b>Award published.</b> Vendors have been notified of their allocation or non-award. No purchase orders are issued by this system.</Alert>}
      {msg && <Alert tone={msg.tone}>{msg.t}</Alert>}
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile k="Requirement" v={`${mt(required)} MT`} />
        <Tile k="Allocated" v={`${mt(calc.total)} MT`} tone={calc.over ? "red" : "teal"} />
        <Tile k="Remaining" v={`${mt(calc.remaining)} MT`} tone={calc.remaining < 0 ? "red" : "navy"} sub={calc.remaining > 0 && calc.total > 0 ? "Under-award is permitted" : undefined} />
        <Tile k="Estimated award value" v={inr(calc.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-navy-600">Award status:</span>{cur ? <StatusBadge status={cur.status} /> : <Badge>not started</Badge>}
        {cur?.cycle_no > 1 && <span className="text-xs text-navy-500">cycle {cur.cycle_no}</span>}
        <div className="ml-auto flex gap-2">
          <a className="rounded-lg border border-navy-200 bg-white px-3 py-1.5 text-sm font-semibold text-navy-800 hover:bg-navy-50" href={`/api/rfqs/${rfqId}/export?type=allocation&format=xlsx`}>⬇ Export</a>
        </div>
      </div>
      <Card pad={false} title="Allocation worksheet">
        <Table><thead><tr><Th>Rank</Th><Th>Vendor</Th><Th>Qualification</Th><Th className="text-right">Final FOR (₹/MT)</Th><Th className="text-right">Offered (MT)</Th><Th className="w-40">Allocate (MT)</Th><Th className="text-right">Est. value</Th><Th className="min-w-56">Procurement remarks</Th></tr></thead><tbody>
          {ws.lines.map((l: any) => {
            const e = calc.errs[l.vendor_id] ?? serverErr[l.vendor_id]; const n = Number(qty[l.vendor_id] || 0);
            return (
              <tr key={l.vendor_id}>
                <Td><span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${l.rank === 1 ? "bg-teal-600 text-white" : "bg-navy-100 text-navy-700"}`}>{l.rank}</span></Td>
                <Td><span className="font-medium">{l.legal_name}</span><div className="text-xs text-navy-500">{l.vendor_code} · {l.origin}</div></Td>
                <Td><StatusBadge status={l.qualification_status} /></Td>
                <Td className="text-right text-base font-bold tabular">{inr(l.current_price)}</Td><Td className="text-right tabular">{mt(l.qty_offered_mt)}</Td>
                <Td><Input inputMode="decimal" disabled={!editable} value={qty[l.vendor_id] ?? ""} onChange={(ev) => setQty({ ...qty, [l.vendor_id]: ev.target.value })} className={`text-right tabular ${e ? "!border-red-400" : ""}`} aria-label={`Quantity for ${l.legal_name}`} />
                  {e && <p role="alert" className="mt-1 text-xs text-red-600">{e}</p>}</Td>
                <Td className="text-right tabular">{n > 0 ? inr(n * Number(l.current_price)) : "—"}</Td>
                <Td><Input disabled={!editable} value={rem[l.vendor_id] ?? ""} onChange={(ev) => setRem({ ...rem, [l.vendor_id]: ev.target.value })} placeholder="Optional" /></Td>
              </tr>);
          })}
          {!ws.lines.length && <tr><Td colSpan={8} className="text-center text-navy-500">No qualified vendors participated.</Td></tr>}
        </tbody>
        <tfoot><tr className="bg-navy-50/60 font-semibold"><Td colSpan={5} className="text-right text-xs uppercase text-navy-600">Total</Td><Td className={`text-right tabular ${calc.over ? "text-red-600" : ""}`}>{mt(calc.total)} MT</Td><Td className="text-right tabular">{inr(calc.value)}</Td><Td /></tr></tfoot></Table>
      </Card>
      {calc.over && <Alert>Total allocation exceeds the RFQ requirement of {mt(required)} MT by {mt(-calc.remaining)} MT.</Alert>}

      <Card title="Workflow">
        <ol className="mb-4 flex flex-wrap gap-2 text-xs font-semibold">
          {["draft", "submitted", "approved", "published"].map((s, i) => {
            const order = ["draft", "submitted", "approved", "published"]; const at = cur ? order.indexOf(cur.status === "rejected" ? "draft" : cur.status) : -1;
            return <li key={s} className={`rounded-full px-3 py-1 ${i <= at ? "bg-teal-600 text-white" : "bg-navy-100 text-navy-500"}`}>{i + 1}. {s === "draft" ? "Draft allocation" : s === "submitted" ? "Submitted for approval" : s === "approved" ? "Approved" : "Award published"}</li>;
          })}
          {cur?.status === "rejected" && <li className="rounded-full bg-red-100 px-3 py-1 text-red-700">Rejected — revise &amp; resubmit</li>}
        </ol>
        <div className="flex flex-wrap gap-2">
          {editable && <Button variant="secondary" busy={busy === "save"} disabled={calc.invalid} onClick={save}>Save draft</Button>}
          {editable && <Button busy={busy === "submit"} disabled={calc.invalid || calc.total <= 0} onClick={() => setDlg("submit")}>Submit for approval</Button>}
          {cur?.status === "submitted" && decider && <>
            <Button busy={busy === "approve"} disabled={selfSubmitted} onClick={() => setDlg("approve")}>Approve</Button>
            <Button variant="danger" disabled={selfSubmitted} onClick={() => setDlg("reject")}>Reject</Button>
            {selfSubmitted && <span className="self-center text-xs text-navy-500">You submitted this award; a different approver must decide (separation of duties).</span>}</>}
          {cur?.status === "submitted" && !decider && <span className="text-sm text-navy-500">Awaiting decision by an approver.</span>}
          {cur?.status === "approved" && decider && <Button busy={busy === "publish"} onClick={() => confirm("Publish the award? Every participating vendor will be notified of their allocation or non-award by e-mail and WhatsApp.") && act("publish", `/api/rfqs/${rfqId}/award/publish`, {}, "Award published; vendors are being notified.")}>Publish award to vendors</Button>}
          {cur?.status === "approved" && !decider && <span className="text-sm text-navy-500">Approved — awaiting publication by an approver.</span>}
        </div>
        <p className="mt-3 text-xs text-navy-500">Publishing communicates the allocation to vendors. This system does not issue purchase orders.</p>
      </Card>

      {ws.cycles.length > 0 && (
        <Card title="Approval history" pad={false}>
          <Table><thead><tr><Th>Cycle</Th><Th>Status</Th><Th>Allocated</Th><Th>Value</Th><Th>Submitted</Th><Th>Decision</Th><Th>Published</Th></tr></thead><tbody>
            {ws.cycles.map((c: any) => (
              <tr key={c.id}><Td>#{c.cycle_no}</Td><Td><StatusBadge status={c.status} /></Td><Td className="tabular">{c.total_allocated_mt ? `${mt(c.total_allocated_mt)} MT` : "—"}</Td><Td className="tabular">{c.total_value ? inr(c.total_value) : "—"}</Td>
                <Td className="text-xs">{c.submitted_by_name ? <>{c.submitted_by_name}<br />{fmtDateTime(c.submitted_at)}{c.submit_remarks && <><br />“{c.submit_remarks}”</>}</> : "—"}</Td>
                <Td className="text-xs">{c.decided_by_name ? <>{c.decided_by_name}<br />{fmtDateTime(c.decided_at)}{c.decision_remarks && <><br />“{c.decision_remarks}”</>}</> : "—"}</Td>
                <Td className="text-xs">{c.published_by_name ? <>{c.published_by_name}<br />{fmtDateTime(c.published_at)}</> : "—"}</Td></tr>))}
          </tbody></Table>
        </Card>)}

      <Modal open={dlg === "submit"} onClose={() => setDlg(null)} title="Submit allocation for approval">
        <p className="mb-3 text-sm text-navy-600">Allocating <b>{mt(calc.total)} MT</b> ({inr(calc.value)}). The allocation is saved, frozen, and sent to an approver. Prices are captured from the closed auction.</p>
        <Field label="Note to approver (optional)"><Textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
          <Button busy={busy === "submit"} onClick={async () => { if (await save()) await act("submit", `/api/rfqs/${rfqId}/award/submit`, { remarks }, "Submitted for approval."); }}>Save & submit</Button></div>
      </Modal>
      <Modal open={dlg === "approve" || dlg === "reject"} onClose={() => setDlg(null)} title={dlg === "approve" ? "Approve award" : "Reject award"}>
        <Field label={dlg === "reject" ? "Reason (required)" : "Remarks (optional)"}><Textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button>
          <Button variant={dlg === "reject" ? "danger" : "primary"} busy={busy === "approve"} onClick={() => act("approve", `/api/rfqs/${rfqId}/award/decide`, { decision: dlg, remarks }, dlg === "approve" ? "Award approved. It can now be published." : "Award rejected; procurement can revise.")}>{dlg === "approve" ? "Approve" : "Reject"}</Button></div>
      </Modal>
    </div>
  );
}
const Tile = ({ k, v, sub, tone = "navy" }: { k: string; v: string; sub?: string; tone?: "navy" | "teal" | "red" }) => (
  <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm"><div className="text-xs font-semibold uppercase tracking-wide text-navy-500">{k}</div>
    <div className={`mt-1 text-xl font-bold tabular ${tone === "red" ? "text-red-600" : tone === "teal" ? "text-teal-700" : "text-navy-900"}`}>{v}</div>{sub && <div className="text-xs text-navy-500">{sub}</div>}</div>);
