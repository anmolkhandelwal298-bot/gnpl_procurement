"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Badge, Button, Card, DemoBadge, Field, Input, Select, Textarea } from "@/components/ui";

export interface RfqFormValues {
  materialName: string; grade: string; requiredQtyMt: string; minGcvArb: string; maxMoisturePct: string; maxAshPct: string; origin: string; otherSpecs: string;
  deliveryLocation: string; deliveryBasis: string; deliverySchedule: string; paymentTerms: string; quotationOpenAt: string; quotationDeadline: string;
  auctionStartAt: string; auctionEndAt: string; minDecrement: string; extEnabled: boolean; extTriggerSeconds: string; extDurationSeconds: string; extMaxCount: string;
  coaRequired: boolean; docRequirements: string; additionalTerms: string; complianceMode: "strict" | "review"; invitedVendorIds: string[];
}
const blank: RfqFormValues = {
  materialName: "Imported Steam Coal", grade: "", requiredQtyMt: "", minGcvArb: "", maxMoisturePct: "", maxAshPct: "", origin: "", otherSpecs: "", deliveryLocation: "",
  deliveryBasis: "FOR", deliverySchedule: "", paymentTerms: "", quotationOpenAt: "", quotationDeadline: "", auctionStartAt: "", auctionEndAt: "", minDecrement: "",
  extEnabled: false, extTriggerSeconds: "120", extDurationSeconds: "120", extMaxCount: "5", coaRequired: true, docRequirements: "", additionalTerms: "", complianceMode: "strict", invitedVendorIds: [],
};

export function RfqForm({ vendors, initial, rfqId, status = "draft" }: {
  vendors: { id: string; vendor_code: string; legal_name: string; city?: string; state?: string; is_demo: boolean }[];
  initial?: Partial<RfqFormValues>; rfqId?: string; status?: string;
}) {
  const router = useRouter();
  const [f, setF] = useState<RfqFormValues>({ ...blank, ...initial });
  const [errs, setErrs] = useState<Record<string, string>>({}); const [err, setErr] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const draft = status === "draft";
  const set = <K extends keyof RfqFormValues>(k: K, v: RfqFormValues[K]) => setF((p) => ({ ...p, [k]: v }));
  const txt = (k: keyof RfqFormValues) => ({ value: f[k] as string, onChange: (e: React.ChangeEvent<any>) => set(k, e.target.value as any) });
  const lock = !draft;                                   // specs are frozen after publication (enforced by the database as well)

  async function save(thenPublish: boolean) {
    setBusy(thenPublish ? "publish" : "save"); setErr(""); setErrs({});
    try {
      let id = rfqId;
      if (id) await apiFetch(`/api/rfqs/${id}`, { method: "PUT", body: f });
      else id = (await apiFetch<{ id: string }>("/api/rfqs", { body: f })).id;
      if (thenPublish) await apiFetch(`/api/rfqs/${id}/publish`, { body: {} });
      router.push(`/admin/rfqs/${id}`); router.refresh();
    } catch (x) { const a = x as ApiError; setErr(a.message); setErrs(a.fields); setBusy(null); window.scrollTo({ top: 0, behavior: "smooth" }); }
  }
  const visible = vendors.filter((v) => v.legal_name.toLowerCase().includes(filter.toLowerCase()) || v.vendor_code.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (id: string) => set("invitedVendorIds", f.invitedVendorIds.includes(id) ? f.invitedVendorIds.filter((x) => x !== id) : [...f.invitedVendorIds, id]);

  return (
    <div className="space-y-5">
      {err && <Alert>{err}</Alert>}
      {lock && <Alert tone="blue">This RFQ is {status.replace(/_/g, " ")}. Specifications and commercial terms are frozen; you can still adjust the schedule, extension settings and informational text.</Alert>}
      <Card title="Material & quantity">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Material name *" error={errs.materialName}><Input disabled={lock} {...txt("materialName")} /></Field>
          <Field label="Grade" error={errs.grade}><Input disabled={lock} {...txt("grade")} placeholder="e.g. GCV 4200 (ARB)" /></Field>
          <Field label="Total required quantity (MT) *" error={errs.requiredQtyMt}><Input disabled={lock} inputMode="decimal" {...txt("requiredQtyMt")} /></Field>
          <Field label="Minimum GCV (ARB) kcal/kg *" error={errs.minGcvArb}><Input disabled={lock} inputMode="numeric" {...txt("minGcvArb")} /></Field>
          <Field label="Maximum total moisture (ARB) % *" error={errs.maxMoisturePct}><Input disabled={lock} inputMode="decimal" {...txt("maxMoisturePct")} /></Field>
          <Field label="Maximum ash %" error={errs.maxAshPct} hint="Leave blank if not applicable"><Input disabled={lock} inputMode="decimal" {...txt("maxAshPct")} /></Field>
          <Field label="Origin / country of origin" error={errs.origin}><Input disabled={lock} {...txt("origin")} placeholder="e.g. Indonesia / South Africa" /></Field>
          <Field label="Other technical specifications" error={errs.otherSpecs} className="sm:col-span-2"><Textarea disabled={lock} rows={2} {...txt("otherSpecs")} placeholder="Sulphur, size, HGI, volatile matter…" /></Field>
        </div>
      </Card>
      <Card title="Delivery & commercial terms">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Delivery location *" error={errs.deliveryLocation} className="sm:col-span-2"><Input disabled={lock} {...txt("deliveryLocation")} /></Field>
          <Field label="Delivery basis" error={errs.deliveryBasis}><Input disabled={lock} {...txt("deliveryBasis")} /></Field>
          <Field label="Delivery schedule" error={errs.deliverySchedule} className="sm:col-span-3"><Input disabled={lock} {...txt("deliverySchedule")} placeholder="e.g. 4 rakes within 30 days of PO" /></Field>
          <Field label="Payment terms" error={errs.paymentTerms} className="sm:col-span-3"><Input disabled={lock} {...txt("paymentTerms")} /></Field>
          <Field label="Additional commercial conditions" error={errs.additionalTerms} className="sm:col-span-3"><Textarea rows={2} {...txt("additionalTerms")} /></Field>
        </div>
      </Card>
      <Card title="Quotation rules & documents">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Quotation window opens" error={errs.quotationOpenAt} hint="Blank = opens on publication"><Input type="datetime-local" disabled={lock} {...txt("quotationOpenAt")} /></Field>
          <Field label="Quotation submission deadline *" error={errs.quotationDeadline}><Input type="datetime-local" disabled={status !== "draft" && status !== "published" && status !== "quotation_open"} {...txt("quotationDeadline")} /></Field>
          <Field label="Technical compliance handling" error={errs.complianceMode} hint="Strict rejects non-compliant quotations on submission; Review accepts and flags them for you.">
            <Select disabled={lock} {...txt("complianceMode")}><option value="strict">Strict — reject non-compliant</option><option value="review">Review — accept & flag</option></Select>
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={lock} checked={f.coaRequired} onChange={(e) => set("coaRequired", e.target.checked)} /> Certificate of Analysis (COA) is mandatory</label>
          <Field label="COA / document requirements" error={errs.docRequirements} className="sm:col-span-2"><Textarea rows={2} {...txt("docRequirements")} placeholder="e.g. Independent surveyor COA dated within 30 days" /></Field>
        </div>
      </Card>
      <Card title="Reverse auction">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Auction start *" error={errs.auctionStartAt}><Input type="datetime-local" {...txt("auctionStartAt")} /></Field>
          <Field label="Auction end *" error={errs.auctionEndAt}><Input type="datetime-local" {...txt("auctionEndAt")} /></Field>
          <Field label="Minimum bid decrement (₹/MT) *" error={errs.minDecrement} hint="Each bid must be at least this much below the vendor's own current price"><Input disabled={lock} inputMode="decimal" {...txt("minDecrement")} /></Field>
        </div>
        <div className="mt-4 rounded-lg bg-navy-50/60 p-4">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.extEnabled} onChange={(e) => set("extEnabled", e.target.checked)} /> Automatically extend the auction when a bid arrives near closing</label>
          {f.extEnabled && (
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <Field label="Trigger window (seconds before end)" error={errs.extTriggerSeconds}><Input inputMode="numeric" {...txt("extTriggerSeconds")} /></Field>
              <Field label="New remaining time after a late bid (seconds)" error={errs.extDurationSeconds}><Input inputMode="numeric" {...txt("extDurationSeconds")} /></Field>
              <Field label="Maximum extensions" error={errs.extMaxCount}><Input inputMode="numeric" {...txt("extMaxCount")} /></Field>
            </div>)}
        </div>
      </Card>
      {draft ? (
        <Card title={<>Invited vendors <Badge tone="teal">{f.invitedVendorIds.length} selected</Badge></>} actions={<Input placeholder="Search vendors" value={filter} onChange={(e) => setFilter(e.target.value)} className="!w-56" />}>
          {errs.invitedVendorIds && <p className="mb-2 text-sm font-medium text-red-600">{errs.invitedVendorIds}</p>}
          <p className="mb-3 text-xs text-navy-500">Only approved vendors can be invited. Vendors never see who else was invited.</p>
          <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
            {visible.map((v) => (
              <label key={v.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${f.invitedVendorIds.includes(v.id) ? "border-teal-500 bg-teal-50" : "border-navy-100 bg-white hover:bg-navy-50"}`}>
                <input type="checkbox" checked={f.invitedVendorIds.includes(v.id)} onChange={() => toggle(v.id)} />
                <span><span className="font-medium">{v.legal_name}</span>{v.is_demo && <DemoBadge />}<span className="block text-xs text-navy-500">{v.vendor_code} · {[v.city, v.state].filter(Boolean).join(", ")}</span></span>
              </label>))}
            {!visible.length && <p className="text-sm text-navy-500">No approved vendors found.</p>}
          </div>
        </Card>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => router.back()}>Cancel</Button>
        <Button variant="secondary" busy={busy === "save"} disabled={!!busy} onClick={() => save(false)}>{draft ? "Save draft" : "Save changes"}</Button>
        {draft && <Button busy={busy === "publish"} disabled={!!busy} onClick={() => confirm("Publish this RFQ and notify the invited vendors by e-mail and WhatsApp? Specifications will be frozen.") && save(true)}>Publish & notify vendors</Button>}
      </div>
    </div>
  );
}
