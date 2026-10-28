"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Alert, Button, Field, Input } from "@/components/ui";

export function LoginForm({ expired }: { expired: boolean }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try { const r = await apiFetch<{ redirect: string }>("/api/auth/login", { body: { email, password } }); window.location.href = r.redirect; }
      catch (x: any) { setErr(x.message); setBusy(false); }
    }}>
      {expired && <Alert tone="amber">Your session expired. Please sign in again.</Alert>}
      {err && <Alert>{err}</Alert>}
      <Field label="E-mail"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Button type="submit" busy={busy} className="w-full" size="lg">Sign in</Button>
      <div className="flex justify-between text-sm">
        <Link className="font-medium text-teal-700 hover:underline" href="/vendor/register">Register as a supplier</Link>
        <Link className="text-navy-500 hover:underline" href="/forgot-password">Forgot password?</Link>
      </div>
    </form>
  );
}
