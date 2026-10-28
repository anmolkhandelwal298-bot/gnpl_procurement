"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { fmtCountdown, useAuctionStream, useCountdown } from "@/lib/use-auction-stream";
import { Alert, Badge, Button, Card, DemoBadge, Field, Input, KV, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { fmtDateTime, fmtDateTimeSec, inr, mt } from "@/lib/format";

export function VendorRfqView({ rfqId, data, award, initialSnap }: { rfqId: string; data: any; award: any; initialSnap: any }) {
  const { snap, connected, now } = useAuctionStream<any>(rfqId, initialSnap);
  const router = useRouter();
  const rfq = data.rfq; const status = snap?.rfq?.status ?? rfq.status;
  const auction = snap?.auction;
  const lastStatus = useRef(status);
  useEffect(() => { if (lastStatus.current !== status) { lastStatus.current = status; router.refresh(); } }, [status, router]);   // reload RFQ/award data when the stage changes
  const showAuction = !!auction && ["scheduled", "live", "closed"].includes(auction.status);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-3"><h1 className="text-2xl font-bold text-navy-900">{rfq.rfq_number}</h1><StatusBadge status={status} />{rfq.is_demo && <DemoBadge />}</div>
        <p className="text-sm text-navy-600">{rfq.material_name}{rfq.grade ? ` · ${rfq.grade}` : ""} · {mt(rfq.required_qty_mt)} MT required</p>
      </div>
      {data.invitation?.status === "declined" && <Alert tone="amber">You declined this invitation.</Alert>}
      {award?.published && <AwardCard award={award} />}
      {showAuction && <AuctionPanel rfqId={rfqId} auction={auction} connected={connected} now={now} />}
      {status === "cancelled" && <Alert>This RFQ has been cancelled by Grainspan.</Alert>}
      {!showAuction && data.offer?.qualification_status === "qualified" && ["qualification", "scheduled"].includes(status) && <Alert tone="green">Your quotation is <b>technically qualified</b>. The live auction is scheduled for {fmtDateTime(rfq.auction_start_at)}.</Alert>}
      {data.offer?.qualification_status === "disqualified" && <Alert>Your quotation was not technically qualified{data.offer.qualification_remarks ? `: ${data.offer.qualification_remarks}` : "."} You will not take part in the auction.</Alert>}
      {data.offer?.revision_allowed && <Alert tone="amber">Grainspan has allowed you to revise your quotation. Update it below; it will be re-qualified.</Alert>}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3"><OfferForm rfqId={rfqId} data={data} /></div>
        <div className="space-y-5 lg:col-span-2"><Requirements rfq={rfq} /></div>
      </div>
    </div>
  );
}

function Requirements({ rfq }: { rfq: any }) {
  return (
    <Card title="Requirement &amp; terms">
      <dl className="space-y-3">
        <KV label="Minimum GCV (ARB)">{rfq.min_gcv_arb} kcal/kg</KV><KV label="Max total moisture (ARB)">{rfq.max_moisture_pct}%</KV>
        <KV label="Max ash">{rfq.max_ash_pct != null ? `${rfq.max_ash_pct}%` : "Not applicable"}</KV><KV label="Origin">{rfq.origin}</KV><KV label="Other specifications">{rfq.other_specs}</KV>
        <KV label="Delivery">{rfq.delivery_basis} — {rfq.delivery_location}</KV><KV label="Delivery schedule">{rfq.delivery_schedule}</KV><KV label="Payment terms">{rfq.payment_terms}</KV>
        <KV label="Documents required">{rfq.coa_required ? "Certificate of Analysis (COA) mandatory. " : ""}{rfq.doc_requirements}</KV>
        <KV label="Additional conditions">{rfq.additional_terms}</KV>
        <KV label="Quotation deadline">{fmtDateTime(rfq.quotation_deadline)}</KV>
        <KV label="Live auction">{fmtDateTime(rfq.auction_start_at)} – {fmtDateTime(rfq.auction_end_at)}</KV>
        <KV label="Minimum bid decrement">{inr(rfq.min_decrement)} per MT below your own current price</KV>
        <KV label="Auction extension">{rfq.ext_enabled ? "A bid placed near closing may extend the auction." : "No automatic extension."}</KV>
      </dl>
    </Card>
  );
}

function AwardCard({ award }: { award: any }) {
  return award.awarded ? (
    <Card className="border-emerald-300 bg-emerald-50/60" title="Award notice">
      <div className="grid gap-4 sm:grid-cols-3">
        <KV label="Allocated quantity"><span className="text-2xl font-bold tabular">{mt(award.allocated_qty_mt)} MT</span></KV>
        <KV label="Accepted FOR price"><span className="text-2xl font-bold tabular">{inr(award.final_price)}</span>/MT</KV>
        <KV label="Estimated value"><span className="text-2xl font-bold tabular">{inr(award.value)}</span></KV>
      </div>
      <p className="mt-3 text-xs text-navy-600">Published {fmtDateTime(award.published_at)}. A purchase order will be issued separately by Grainspan.</p>
    </Card>
  ) : (
    <Alert tone="blue"><b>Outcome:</b> no quantity has been allocated to your company on this RFQ. Thank you for participating.</Alert>
  );
}

// ---------------------------------------------------------------- live auction
function AuctionPanel({ rfqId, auction, connected, now }: { rfqId: string; auction: any; connected: boolean; now: () => number }) {
  const nowMs = now();
  const started = Date.parse(auction.start_at) <= nowMs;
  const running = auction.status === "live" && Date.parse(auction.end_at) > nowMs;
  const target = auction.status === "scheduled" || !started ? auction.start_at : auction.status === "live" ? auction.end_at : null;
  const remaining = useCountdown(target, now);
  const [amount, setAmount] = useState(""); const [busy, setBusy] = useState(false); const [result, setResult] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const keyRef = useRef<string>(crypto.randomUUID());
  const [bump, setBump] = useState(false); const prevRank = useRef<number | null>(auction.rank); const prevPrice = useRef<string>(auction.current_price);
  const maxNext = auction.max_next_bid != null ? Number(auction.max_next_bid) : null;

  useEffect(() => {
    if (prevRank.current !== auction.rank || prevPrice.current !== auction.current_price) { setBump(true); const t = setTimeout(() => setBump(false), 700); prevRank.current = auction.rank; prevPrice.current = auction.current_price; return () => clearTimeout(t); }
  }, [auction.rank, auction.current_price]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setResult(null);
    const n = Number(amount);
    if (!amount || Number.isNaN(n) || n <= 0) { setResult({ tone: "red", text: "Enter your new FOR price in ₹ per MT." }); return; }
    if (maxNext !== null && n > maxNext + 1e-9) { setResult({ tone: "red", text: `Your bid must be ${inr(maxNext)}/MT or lower (at least ${inr(auction.min_decrement)} below your current price).` }); return; }
    if (!confirm(`Submit a bid of ${inr(n)} per MT? Bids cannot be withdrawn.`)) return;
    setBusy(true);
    try {
      const r = await apiFetch<any>(`/api/auctions/${auction.auction_id}/bids`, { body: { amount, idempotencyKey: keyRef.current } });
      keyRef.current = crypto.randomUUID(); setAmount("");
      setResult({ tone: "green", text: `Bid accepted: ${inr(r.bid.amount)}/MT at ${fmtDateTimeSec(r.bid.accepted_at)}. Your rank is now ${r.rank}.${r.extended ? " The auction end time was extended." : ""}` });
    } catch (x) {
      const a = x as ApiError;
      if (a.status && a.status < 500 && a.status !== 429) keyRef.current = crypto.randomUUID();      // definitive answer → next attempt is a new request
      setResult({ tone: "red", text: a.message });                                                       // network/5xx: keep the key so a retry cannot double-apply
    } finally { setBusy(false); }
  }

  const label = auction.status === "closed" || (auction.status === "live" && !running) ? "closed" : started ? "live" : "scheduled";
  return (
    <Card pad={false} className="overflow-hidden border-2 border-navy-800">
      <div className="bg-navy-900 px-5 py-3 text-white">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><StatusBadge status={label === "live" ? "live" : label === "closed" ? "closed" : "scheduled"} />
            <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-emerald-300" : "text-amber-300"}`}><span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} />{connected ? "Live connection" : "Reconnecting…"}</span></div>
          <div className="text-right"><div className="text-[10px] uppercase tracking-widest text-navy-300">{label === "scheduled" ? "Auction starts in" : label === "live" ? "Time remaining" : "Auction"}</div>
            <div className="text-3xl font-bold tabular sm:text-4xl" aria-live="off">{target && label !== "closed" ? fmtCountdown(remaining) : "CLOSED"}</div></div>
        </div>
      </div>
      <div className="grid gap-px bg-navy-100 sm:grid-cols-2">
        <div className="bg-white p-5"><div className="text-xs font-semibold uppercase tracking-wider text-navy-500">Your current FOR price</div>
          <div className={`mt-1 text-4xl font-extrabold tabular text-navy-900 sm:text-5xl ${bump ? "pop" : ""}`}>{inr(auction.current_price)}<span className="text-base font-medium text-navy-500"> /MT</span></div>
          <div className="mt-1 text-xs text-navy-500">Initial quote {inr(auction.initial_price)} · {auction.bid_count} bid{auction.bid_count === 1 ? "" : "s"} placed</div></div>
        <div className="bg-white p-5"><div className="text-xs font-semibold uppercase tracking-wider text-navy-500">Your rank</div>
          <div className={`mt-1 flex items-baseline gap-2 ${bump ? "pop" : ""}`}><span className={`text-5xl font-extrabold tabular sm:text-6xl ${auction.rank === 1 ? "text-teal-600" : "text-navy-900"}`}>{auction.rank ?? "—"}</span>
            {auction.rank === 1 && <Badge tone="teal">Lowest price</Badge>}</div>
          <div className="mt-1 text-xs text-navy-500">Rank 1 = lowest eligible FOR price. Ties are ranked by who reached the price first.</div></div>
      </div>
      <div className="p-5">
        {label === "live" ? (
          <form onSubmit={submit} className="space-y-3">
            <Field label="Your new FOR price (₹ per MT)" hint={maxNext !== null ? `Maximum allowed: ${inr(maxNext)} — each bid must be at least ${inr(auction.min_decrement)} below your current price.` : undefined}>
              <div className="flex gap-2">
                <Input inputMode="decimal" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={maxNext !== null ? String(maxNext) : ""} className="!py-3 !text-lg font-semibold tabular" disabled={busy} />
                {maxNext !== null && <Button type="button" variant="secondary" onClick={() => setAmount(String(maxNext))}>Max</Button>}
              </div>
            </Field>
            <Button type="submit" size="lg" busy={busy} className="w-full sm:w-auto">Submit bid</Button>
          </form>
        ) : label === "scheduled" ? <Alert tone="blue">The auction opens {fmtDateTime(auction.start_at)}. You can bid here once it starts — no need to refresh the page.</Alert>
          : <Alert tone="blue">The auction has closed. Your final FOR price was <b>{inr(auction.current_price)}/MT</b>. Grainspan will communicate the outcome after evaluation.</Alert>}
        {result && <div className="mt-3"><Alert tone={result.tone}>{result.text}</Alert></div>}
      </div>
      {auction.history?.length > 0 && (
        <div className="border-t border-navy-100"><div className="px-5 pt-3 text-xs font-semibold uppercase tracking-wider text-navy-500">Your bid history</div>
          <Table><thead><tr><Th>Server time</Th><Th>Result</Th><Th className="text-right">Bid (₹/MT)</Th><Th>Note</Th></tr></thead><tbody>
            {auction.history.map((h: any, i: number) => (
              <tr key={i}><Td className="whitespace-nowrap text-xs tabular">{fmtDateTimeSec(h.at)}</Td>
                <Td>{h.type === "accepted" ? <Badge tone="green">Accepted</Badge> : <Badge tone="red">Rejected</Badge>}</Td>
                <Td className="text-right tabular font-semibold">{inr(h.amount)}</Td>
                <Td className="text-xs text-navy-600">{h.type === "accepted" ? `from ${inr(h.previous_amount)}` : h.message}</Td></tr>))}
          </tbody></Table></div>)}
    </Card>
  );
}

// ---------------------------------------------------------------- quotation
const toStr = (v: unknown) => (v === null || v === undefined ? "" : String(v));
function OfferForm({ rfqId, data }: { rfqId: string; data: any }) {
  const router = useRouter();
  const { rfq, offer, documents, editable } = data;
  const [f, setF] = useState({
    origin: toStr(offer?.origin), gcvArb: toStr(offer?.gcv_arb), moisturePct: toStr(offer?.moisture_pct), ashPct: toStr(offer?.ash_pct), qtyOfferedMt: toStr(offer?.qty_offered_mt),
    initialForPrice: toStr(offer?.initial_for_price), leadTimeDays: toStr(offer?.lead_time_days), remarks: toStr(offer?.remarks),
    sulphur: toStr(offer?.other_params?.sulphur_pct), size: toStr(offer?.other_params?.size_mm), hgi: toStr(offer?.other_params?.hgi),
  });
  const [errs, setErrs] = useState<Record<string, string>>({}); const [msg, setMsg] = useState<{ tone: "red" | "green" | "amber"; t: string } | null>(null); const [issues, setIssues] = useState<any[]>([]);
  const [busy, setBusy] = useState(""); const [up, setUp] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const submitted = offer?.status === "submitted";
  const body = (submit: boolean) => ({
    origin: f.origin, gcvArb: f.gcvArb, moisturePct: f.moisturePct, ashPct: f.ashPct, qtyOfferedMt: f.qtyOfferedMt, initialForPrice: f.initialForPrice, leadTimeDays: f.leadTimeDays, remarks: f.remarks, submit,
    otherParams: Object.fromEntries(Object.entries({ sulphur_pct: f.sulphur, size_mm: f.size, hgi: f.hgi }).filter(([, v]) => v)),
  });
  async function save(submit: boolean) {
    setBusy(submit ? "submit" : "save"); setMsg(null); setErrs({}); setIssues([]);
    try { await apiFetch(`/api/vendor/rfqs/${rfqId}/offer`, { method: "PUT", body: body(submit) }); setMsg({ tone: "green", t: submit ? "Quotation submitted. You can update it until the deadline." : "Draft saved." }); router.refresh(); }
    catch (x) { const a = x as ApiError; setErrs(a.fields); if (a.code === "NON_COMPLIANT") setIssues((a.details as any[]) ?? []); setMsg({ tone: "red", t: a.code === "INCOMPLETE" ? `Please complete: ${a.message.replace("missing ", "")}` : a.message }); }
    finally { setBusy(""); }
  }
  async function upload(file: File, docType: "coa" | "supporting") {
    setUp(true); setMsg(null);
    try { const fd = new FormData(); fd.append("file", file); fd.append("docType", docType); await apiFetch(`/api/vendor/rfqs/${rfqId}/documents`, { form: fd }); router.refresh(); }
    catch (x: any) { setMsg({ tone: "red", t: x.message }); } finally { setUp(false); }
  }
  const dis = !editable || !!busy;
  const hint = (ok: boolean | null, text: string) => ok === null ? <span>{text}</span> : <span className={ok ? "text-emerald-700" : "font-semibold text-red-600"}>{text}</span>;
  const gcvOk = f.gcvArb ? Number(f.gcvArb) >= rfq.min_gcv_arb : null, mOk = f.moisturePct ? Number(f.moisturePct) <= Number(rfq.max_moisture_pct) : null;
  const aOk = f.ashPct && rfq.max_ash_pct != null ? Number(f.ashPct) <= Number(rfq.max_ash_pct) : null;

  return (
    <Card title="My quotation" actions={offer ? <StatusBadge status={offer.status} /> : <Badge tone="amber">Not started</Badge>}>
      {!editable && <div className="mb-4"><Alert tone="blue">{rfq.status === "quotation_open" ? "The quotation deadline has passed." : "Technical specifications, quantity and initial price are locked."} Only your FOR price can change, and only during the live auction.</Alert></div>}
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.t}</Alert></div>}
      {issues.length > 0 && <div className="mb-4"><Alert>{issues.map((i: any) => <div key={i.field}>• {i.message}</div>)}</Alert></div>}
      {offer?.is_compliant === false && <div className="mb-4"><Alert tone="amber"><b>Technical deviations noted:</b>{(offer.compliance_issues ?? []).map((i: any) => <div key={i.field}>• {i.message}</div>)}Grainspan will decide whether your quotation can be qualified.</Alert></div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Material origin *" error={errs.origin}><Input disabled={dis} value={f.origin} onChange={set("origin")} placeholder="e.g. Indonesia" /></Field>
        <Field label="Quantity offered (MT) *" error={errs.qtyOfferedMt}><Input disabled={dis} inputMode="decimal" value={f.qtyOfferedMt} onChange={set("qtyOfferedMt")} /></Field>
        <Field label="GCV (ARB), kcal/kg *" error={errs.gcvArb} hint={undefined}><Input disabled={dis} inputMode="numeric" value={f.gcvArb} onChange={set("gcvArb")} /><span className="mt-1 block text-xs">{hint(gcvOk, `Required: ≥ ${rfq.min_gcv_arb}`)}</span></Field>
        <Field label="Total moisture (ARB), % *" error={errs.moisturePct}><Input disabled={dis} inputMode="decimal" value={f.moisturePct} onChange={set("moisturePct")} /><span className="mt-1 block text-xs">{hint(mOk, `Required: ≤ ${rfq.max_moisture_pct}%`)}</span></Field>
        <Field label={`Ash content, %${rfq.max_ash_pct != null ? " *" : ""}`} error={errs.ashPct}><Input disabled={dis} inputMode="decimal" value={f.ashPct} onChange={set("ashPct")} /><span className="mt-1 block text-xs">{rfq.max_ash_pct != null ? hint(aOk, `Required: ≤ ${rfq.max_ash_pct}%`) : "Not restricted"}</span></Field>
        <Field label="Delivery lead time (days) *" error={errs.leadTimeDays}><Input disabled={dis} inputMode="numeric" value={f.leadTimeDays} onChange={set("leadTimeDays")} /></Field>
        <Field label="Initial FOR price (₹ per MT) *" error={errs.initialForPrice} hint="This is your starting price. It can only be lowered, during the live auction."><Input disabled={dis} inputMode="decimal" value={f.initialForPrice} onChange={set("initialForPrice")} className="font-semibold tabular" /></Field>
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          <Field label="Sulphur % (optional)"><Input disabled={dis} inputMode="decimal" value={f.sulphur} onChange={set("sulphur")} /></Field>
          <Field label="Size, mm (optional)"><Input disabled={dis} value={f.size} onChange={set("size")} /></Field>
          <Field label="HGI (optional)"><Input disabled={dis} value={f.hgi} onChange={set("hgi")} /></Field>
        </div>
        <Field label="Commercial remarks" error={errs.remarks} className="sm:col-span-2"><Textarea disabled={dis} rows={3} value={f.remarks} onChange={set("remarks")} /></Field>
      </div>

      <div className="mt-5 border-t border-navy-100 pt-4">
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold text-navy-800">Documents {rfq.coa_required && <Badge tone="amber">COA mandatory</Badge>}</h3></div>
        <ul className="mb-3 space-y-1.5">
          {documents.map((d: any) => (
            <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-navy-100 px-3 py-2 text-sm">
              <a className="min-w-0 truncate font-medium text-navy-700 hover:underline" href={`/api/documents/${d.id}`}>⬇ <Badge tone={d.doc_type === "coa" ? "teal" : "gray"}>{d.doc_type.toUpperCase()}</Badge> {d.filename}</a>
              <span className="flex shrink-0 items-center gap-3 text-xs text-navy-500">{Math.round(d.size_bytes / 1024)} KB
                {editable && <button className="font-semibold text-red-600 hover:underline" onClick={async () => { if (!confirm("Remove this document?")) return; try { await apiFetch(`/api/documents/${d.id}`, { method: "DELETE" }); router.refresh(); } catch (e: any) { setMsg({ tone: "red", t: e.message }); } }}>Remove</button>}</span>
            </li>))}
          {!documents.length && <li className="text-sm text-navy-500">No documents uploaded yet.</li>}
        </ul>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <label className="cursor-pointer rounded-lg border border-teal-600 px-3 py-2 text-sm font-semibold text-teal-700 hover:bg-teal-50">{up ? "Uploading…" : "Upload COA"}<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx" disabled={up} onChange={(e) => { const x = e.target.files?.[0]; if (x) upload(x, "coa"); e.target.value = ""; }} /></label>
            <label className="cursor-pointer rounded-lg border border-navy-200 px-3 py-2 text-sm font-semibold text-navy-700 hover:bg-navy-50">Upload supporting document<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx" disabled={up} onChange={(e) => { const x = e.target.files?.[0]; if (x) upload(x, "supporting"); e.target.value = ""; }} /></label>
            <span className="self-center text-xs text-navy-500">PDF, PNG, JPEG, XLSX or DOCX · max 10 MB · stored privately</span>
          </div>)}
      </div>

      {editable && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-navy-100 pt-4">
          {!submitted && <Button variant="secondary" busy={busy === "save"} disabled={!!busy} onClick={() => save(false)}>Save draft</Button>}
          <Button busy={busy === "submit"} disabled={!!busy} onClick={() => confirm("Submit this quotation to Grainspan?") && save(true)}>{submitted ? "Update quotation" : "Submit quotation"}</Button>
          {submitted && rfq.status === "quotation_open" && <Button variant="ghost" className="text-red-700" disabled={!!busy} onClick={async () => { if (!confirm("Withdraw your quotation? You can submit again before the deadline.")) return; try { await apiFetch(`/api/vendor/rfqs/${rfqId}/withdraw`, { body: {} }); router.refresh(); } catch (e: any) { setMsg({ tone: "red", t: e.message }); } }}>Withdraw</Button>}
        </div>)}
      {offer?.submitted_at && <p className="mt-3 text-xs text-navy-500">Last submitted {fmtDateTime(offer.submitted_at)} · version {offer.version}</p>}
      {offer?.qualification_status && <p className="mt-1 text-xs text-navy-500">Technical review: <b>{offer.qualification_status}</b></p>}
    </Card>
  );
}
