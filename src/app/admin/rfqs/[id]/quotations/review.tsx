"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Alert, Badge, Button, Card, DemoBadge, Empty, Field, Modal, StatusBadge, Textarea } from "@/components/ui";
import { fmtDateTime, inr, mt } from "@/lib/format";

const bad = "font-semibold text-red-600";

export function QuotationReview({ rfq, rows, docs, canEdit }: { rfq: any; rows: any[]; docs: any[]; canEdit: boolean }) {
  const router = useRouter();
  const [dlg, setDlg] = useState<{ row: any; status: "qualified" | "disqualified" | "pending" } | null>(null);
  const [remarks, setRemarks] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [fe, setFe] = useState("");
  const phase = ["quotation_open", "qualification"].includes(rfq.status);
  const submit = async () => {
    if (!dlg) return; setBusy(true); setErr(""); setFe("");
    try { await apiFetch(`/api/offers/${dlg.row.offer_id}/qualify`, { body: { status: dlg.status, remarks } }); setDlg(null); setRemarks(""); router.refresh(); }
    catch (e: any) { setErr(e.message); setFe(e.fields?.remarks ?? ""); } finally { setBusy(false); }
  };
  const revision = async (row: any, allowed: boolean) => { try { await apiFetch(`/api/offers/${row.offer_id}/revision`, { body: { allowed } }); router.refresh(); } catch (e: any) { alert(e.message); } };

  return (
    <div className="space-y-4">
      <Alert tone="blue">Technical qualification is separate from price. Only <b>qualified</b> vendors are ranked and can bid. Requirements: GCV ≥ <b>{rfq.min_gcv_arb}</b> kcal/kg · moisture ≤ <b>{rfq.max_moisture_pct}%</b>{rfq.max_ash_pct != null && <> · ash ≤ <b>{rfq.max_ash_pct}%</b></>} · {rfq.compliance_mode === "strict" ? "strict mode (non-compliant quotations are rejected at submission)" : "review mode (non-compliant quotations are flagged for your decision)"}.</Alert>
      {rows.length === 0 && <Empty>No vendors invited.</Empty>}
      {rows.map((r) => {
        const mine = docs.filter((d) => d.offer_id === r.offer_id);
        const has = r.offer_status === "submitted";
        return (
          <Card key={r.vendor_id} title={<span>{r.legal_name}{r.is_demo && <DemoBadge />} <span className="ml-2 text-xs font-normal normal-case text-navy-500">{r.vendor_code}</span></span>}
            actions={<><StatusBadge status={r.invitation_status} />{r.offer_status && <StatusBadge status={r.offer_status} />}{r.qualification_status && <StatusBadge status={r.qualification_status} />}</>}>
            {!r.offer_status || r.offer_status === "draft" ? (
              <p className="text-sm text-navy-500">{r.invitation_status === "declined" ? `Declined${r.decline_reason ? `: ${r.decline_reason}` : ""}.` : r.offer_status === "draft" ? "Quotation saved as a draft but not submitted." : "No quotation received."}</p>
            ) : (
              <div className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
                  <Cell k="Origin">{r.origin}</Cell>
                  <Cell k="GCV (ARB)"><span className={r.gcv_arb < rfq.min_gcv_arb ? bad : ""}>{r.gcv_arb} kcal/kg</span></Cell>
                  <Cell k="Moisture"><span className={Number(r.moisture_pct) > Number(rfq.max_moisture_pct) ? bad : ""}>{r.moisture_pct}%</span></Cell>
                  <Cell k="Ash"><span className={rfq.max_ash_pct != null && Number(r.ash_pct) > Number(rfq.max_ash_pct) ? bad : ""}>{r.ash_pct != null ? `${r.ash_pct}%` : "—"}</span></Cell>
                  <Cell k="Quantity offered">{mt(r.qty_offered_mt)} MT</Cell>
                  <Cell k="Initial FOR">{inr(r.initial_for_price)}/MT</Cell>
                  <Cell k="Lead time">{r.lead_time_days} days</Cell>
                </dl>
                {r.remarks && <p className="rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-700"><b>Vendor remarks:</b> {r.remarks}</p>}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {r.is_compliant === true && <Badge tone="green">Technically compliant</Badge>}
                  {r.is_compliant === false && <Badge tone="red">Deviations</Badge>}
                  {(r.compliance_issues ?? []).map((i: any) => <span key={i.field} className="text-xs text-red-700">• {i.message}</span>)}
                  <span className="ml-auto text-xs text-navy-500">Submitted {fmtDateTime(r.submitted_at)}</span>
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  {mine.length ? mine.map((d) => <a key={d.id} href={`/api/documents/${d.id}`} className="rounded-lg border border-navy-200 px-2.5 py-1 text-xs font-medium text-navy-700 hover:bg-navy-50">⬇ {d.doc_type.toUpperCase()}: {d.filename} ({Math.round(d.size_bytes / 1024)} KB)</a>) : <span className="text-xs text-red-600">No documents uploaded</span>}
                </div>
                {r.qualification_remarks && <p className="text-sm text-navy-600"><b>Qualification note:</b> {r.qualification_remarks}</p>}
                {canEdit && (
                  <div className="flex flex-wrap gap-2 border-t border-navy-50 pt-3">
                    {phase && r.qualification_status !== "qualified" && <Button size="sm" onClick={() => { setRemarks(""); setDlg({ row: r, status: "qualified" }); }}>Qualify</Button>}
                    {phase && r.qualification_status !== "disqualified" && <Button size="sm" variant="danger" onClick={() => { setRemarks(""); setDlg({ row: r, status: "disqualified" }); }}>Disqualify</Button>}
                    {phase && r.qualification_status !== "pending" && <Button size="sm" variant="secondary" onClick={() => { setRemarks(""); setDlg({ row: r, status: "pending" }); }}>Reset to pending</Button>}
                    {rfq.status === "qualification" && !r.revision_allowed && <Button size="sm" variant="ghost" onClick={() => revision(r, true)}>Allow vendor to revise</Button>}
                    {r.revision_allowed && <><Badge tone="amber">Revision allowed — awaiting vendor</Badge><Button size="sm" variant="ghost" onClick={() => revision(r, false)}>Withdraw permission</Button></>}
                  </div>)}
              </div>)}
          </Card>);
      })}
      <Modal open={!!dlg} onClose={() => setDlg(null)} title={dlg ? `${dlg.status === "qualified" ? "Qualify" : dlg.status === "disqualified" ? "Disqualify" : "Reset"} ${dlg.row.legal_name}` : ""}>
        {err && <div className="mb-3"><Alert>{err}</Alert></div>}
        {dlg?.row.is_compliant === false && dlg.status === "qualified" && <div className="mb-3"><Alert tone="amber">This quotation has technical deviations. Record why it is acceptable.</Alert></div>}
        <Field label={dlg?.status === "disqualified" ? "Reason (required)" : "Remarks"} error={fe}><Textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button busy={busy} variant={dlg?.status === "disqualified" ? "danger" : "primary"} onClick={submit}>Confirm</Button></div>
      </Modal>
    </div>
  );
}
const Cell = ({ k, children }: { k: string; children: React.ReactNode }) => <div><dt className="text-xs font-medium uppercase tracking-wide text-navy-500">{k}</dt><dd className="mt-0.5 font-medium tabular">{children || "—"}</dd></div>;
