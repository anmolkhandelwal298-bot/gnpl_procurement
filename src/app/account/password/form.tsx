"use client";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export function ChangePasswordForm() {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [fe, setFe] = useState<Record<string, string>>({});
  return (
    <Card>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(""); setFe({});
        try { const r = await apiFetch<{ redirect: string }>("/api/auth/change-password", { body: { currentPassword: cur, newPassword: next } }); window.location.href = r.redirect; }
        catch (x) { const a = x as ApiError; setErr(a.message); setFe(a.fields); setBusy(false); }
      }}>
        {err && <Alert>{err}</Alert>}
        <Field label="Current password" error={fe.currentPassword}><Input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password" error={fe.newPassword} hint="At least 10 characters, with a letter and a number"><Input type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Button type="submit" busy={busy} className="w-full">Update password</Button>
      </form>
    </Card>
  );
}
