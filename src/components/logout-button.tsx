"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

export function LogoutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className={className ?? "rounded-lg px-3 py-1.5 text-sm font-medium text-navy-100 hover:bg-white/10"} disabled={busy}
      onClick={async () => { setBusy(true); try { await apiFetch("/api/auth/logout", { method: "POST", body: {} }); } finally { window.location.href = "/login"; } }}>
      Sign out
    </button>
  );
}
