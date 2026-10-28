"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

const empty = { legalName: "", gstin: "", pan: "", contactName: "", email: "", phone: "", whatsapp: "", address: "", city: "", state: "", country: "India", password: "" };

export function RegisterForm() {
  const [f, setF] = useState(empty); const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [done, setDone] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  if (done) return (
    <Card><Alert tone="green"><b>Registration received.</b> Grainspan procurement will review your company details. You will be able to sign in immediately, but you can only be invited to RFQs once your registration is approved.</Alert>
      <p className="mt-4"><Link className="font-semibold text-teal-700 hover:underline" href="/login">Go to sign in →</Link></p></Card>
  );
  return (
    <form onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(""); setErrs({});
      try { await apiFetch("/api/auth/register", { body: f }); setDone(true); }
      catch (x) { const a = x as ApiError; setErrs(a.fields); setErr(a.message); } finally { setBusy(false); }
    }} className="space-y-5">
      {err && <Alert>{err}</Alert>}
      <Card title="Company">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal company name *" error={errs.legalName} className="sm:col-span-2"><Input required value={f.legalName} onChange={set("legalName")} /></Field>
          <Field label="GSTIN" error={errs.gstin} hint="15-character GST number (leave blank for overseas suppliers)"><Input value={f.gstin} onChange={set("gstin")} maxLength={15} /></Field>
          <Field label="PAN" error={errs.pan}><Input value={f.pan} onChange={set("pan")} maxLength={10} /></Field>
          <Field label="Address" error={errs.address} className="sm:col-span-2"><Input value={f.address} onChange={set("address")} /></Field>
          <Field label="City" error={errs.city}><Input value={f.city} onChange={set("city")} /></Field>
          <Field label="State" error={errs.state}><Input value={f.state} onChange={set("state")} /></Field>
        </div>
      </Card>
      <Card title="Contact &amp; login">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact person *" error={errs.contactName}><Input required value={f.contactName} onChange={set("contactName")} /></Field>
          <Field label="E-mail (also your login) *" error={errs.email}><Input type="email" required value={f.email} onChange={set("email")} /></Field>
          <Field label="Phone" error={errs.phone}><Input value={f.phone} onChange={set("phone")} /></Field>
          <Field label="WhatsApp number" error={errs.whatsapp} hint="International format, e.g. +919876543210 — used for RFQ & auction alerts"><Input value={f.whatsapp} onChange={set("whatsapp")} placeholder="+91…" /></Field>
          <Field label="Password *" error={errs.password} hint="At least 10 characters, with a letter and a number" className="sm:col-span-2"><Input type="password" autoComplete="new-password" required value={f.password} onChange={set("password")} /></Field>
        </div>
      </Card>
      <div className="flex items-center justify-between">
        <Link href="/login" className="text-sm text-navy-500 hover:underline">← Back to sign in</Link>
        <Button type="submit" busy={busy} size="lg">Submit registration</Button>
      </div>
    </form>
  );
}
