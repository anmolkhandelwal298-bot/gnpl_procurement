"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Alert, Button } from "@/components/ui";

export function VerifyChain() {
  const [r, setR] = useState<any>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="secondary" busy={busy} onClick={async () => { setBusy(true); try { setR(await apiFetch("/api/audit/verify")); } catch (e: any) { setR({ ok: false, reason: e.message }); } finally { setBusy(false); } }}>Verify audit-chain integrity</Button>
      {r && (r.ok ? <Alert tone="green">Chain intact — {Number(r.checked).toLocaleString("en-IN")} entries verified.</Alert>
        : <Alert>Integrity check FAILED{r.first_bad_seq ? ` at entry #${r.first_bad_seq}` : ""}: {r.reason}</Alert>)}
    </div>
  );
}
