"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { Logo } from "@/components/brand";

function Inner() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState(""); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [fe, setFe] = useState("");
  return (
    <Card>
      {done ? <Alert tone="green">Password updated. <Link className="font-semibold underline" href="/login">Sign in</Link></Alert> : (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr(""); setFe("");
          try { await apiFetch("/api/auth/reset", { body: { token, password } }); setDone(true); } catch (x: any) { setErr(x.message); setFe(x.fields?.password ?? ""); } finally { setBusy(false); }
        }}>
          {err && <Alert>{err}</Alert>}
          <Field label="New password" error={fe} hint="At least 10 characters, with a letter and a number"><Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" busy={busy} className="w-full">Set new password</Button>
        </form>
      )}
    </Card>
  );
}
export default function ResetPassword() {
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <Link href="/login"><Logo /></Link>
      <h1 className="mb-4 mt-6 text-2xl font-bold text-navy-900">Choose a new password</h1>
      <Suspense><Inner /></Suspense>
    </main>
  );
}
