"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Button, Card, Field, Input, KV, StatusBadge } from "@/components/ui";

export function ProfileForm({ v }: { v: any }) {
  const [f, setF] = useState({ contactName: v.contact_name ?? "", contactEmail: v.contact_email ?? "", contactPhone: v.contact_phone ?? "", whatsapp: v.whatsapp_number ?? "", address: v.address ?? "", emailNotifications: v.email_notifications, whatsappNotifications: v.whatsapp_notifications });
  const [fe, setFe] = useState<Record<string, string>>({}); const [msg, setMsg] = useState<{ tone: "green" | "red"; t: string } | null>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-navy-900">Company profile</h1>
      <Card title="Registered details"><dl className="grid gap-4 sm:grid-cols-4"><KV label="Vendor ID">{v.vendor_code}</KV><KV label="Company">{v.legal_name}</KV><KV label="GSTIN">{v.gstin}</KV><KV label="Status"><StatusBadge status={v.status} /></KV></dl>
        <p className="mt-3 text-xs text-navy-500">To change legal name, GSTIN or PAN, contact Grainspan procurement.</p></Card>
      <Card title="Contact &amp; notifications">
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setMsg(null); setFe({}); try { await apiFetch("/api/vendor/profile", { method: "PUT", body: f }); setMsg({ tone: "green", t: "Profile updated." }); } catch (x) { const a = x as ApiError; setFe(a.fields); setMsg({ tone: "red", t: a.message }); } finally { setBusy(false); } }}>
          {msg && <Alert tone={msg.tone}>{msg.t}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Contact person" error={fe.contactName}><Input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
            <Field label="Notification e-mail" error={fe.contactEmail}><Input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
            <Field label="Phone" error={fe.contactPhone}><Input value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></Field>
            <Field label="WhatsApp number" error={fe.whatsapp} hint="International format, e.g. +919876543210"><Input value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} /></Field>
            <Field label="Address" error={fe.address} className="sm:col-span-2"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          </div>
          <div className="space-y-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={f.emailNotifications} onChange={(e) => setF({ ...f, emailNotifications: e.target.checked })} /> E-mail notifications (RFQ invitations, reminders, auction alerts, awards)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.whatsappNotifications} onChange={(e) => setF({ ...f, whatsappNotifications: e.target.checked })} /> WhatsApp notifications</label></div>
          <div className="flex items-center justify-between"><Link href="/account/password" className="text-sm font-medium text-teal-700 hover:underline">Change password</Link><Button type="submit" busy={busy}>Save</Button></div>
        </form>
      </Card>
    </div>
  );
}
