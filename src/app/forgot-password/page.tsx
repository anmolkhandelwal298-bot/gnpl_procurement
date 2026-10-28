"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { Logo } from "@/components/brand";

export default function ForgotPassword() {
  const [email, setEmail] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <Link href="/login"><Logo /></Link>
      <h1 className="mb-4 mt-6 text-2xl font-bold text-navy-900">Reset password</h1>
      <Card>
        {msg ? <Alert tone="green">{msg}</Alert> : (
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setErr("");
            try { setMsg((await apiFetch<{ message: string }>("/api/auth/forgot", { body: { email } })).message); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
          }}>
            {err && <Alert>{err}</Alert>}
            <Field label="Your account e-mail"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Button type="submit" busy={busy} className="w-full">Send reset link</Button>
          </form>
        )}
        <p className="mt-4 text-sm"><Link className="text-teal-700 hover:underline" href="/login">← Back to sign in</Link></p>
      </Card>
    </main>
  );
}
