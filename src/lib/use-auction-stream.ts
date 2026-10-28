"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Subscribes to /api/rfqs/:id/stream (SSE). The server pushes a complete, role-filtered snapshot after every committed change.
 * Falls back to polling /snapshot if the stream is down for more than a few seconds. `now()` is a server-synchronised clock used
 * ONLY for display (countdowns) — the server alone decides whether a bid is on time.
 */
export function useAuctionStream<T extends { serverTime: string | Date }>(rfqId: string, initial: T | null) {
  const [snap, setSnap] = useState<T | null>(initial);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const offset = useRef(initial ? Date.parse(String(initial.serverTime)) - Date.now() : 0);
  const now = useCallback(() => Date.now() + offset.current, []);

  useEffect(() => {
    let es: EventSource | null = null, poll: ReturnType<typeof setInterval> | null = null, down: ReturnType<typeof setTimeout> | null = null, stopped = false;
    const apply = (s: T) => { offset.current = Date.parse(String(s.serverTime)) - Date.now(); setSnap(s); setVersion((v) => v + 1); };
    const startPolling = () => {
      if (poll || stopped) return;
      poll = setInterval(async () => { try { const r = await fetch(`/api/rfqs/${rfqId}/snapshot`, { cache: "no-store" }); if (r.ok) apply(await r.json()); else if (r.status === 401) window.location.href = "/login?expired=1"; } catch { /* retry */ } }, 3000);
    };
    const connect = () => {
      es = new EventSource(`/api/rfqs/${rfqId}/stream`);
      es.addEventListener("snapshot", (e) => { setConnected(true); if (poll) { clearInterval(poll); poll = null; } if (down) { clearTimeout(down); down = null; } apply(JSON.parse((e as MessageEvent).data)); });
      es.addEventListener("auth", () => { window.location.href = "/login?expired=1"; });
      es.onerror = () => { setConnected(false); if (!down) down = setTimeout(startPolling, 6000); };
    };
    connect();
    return () => { stopped = true; es?.close(); if (poll) clearInterval(poll); if (down) clearTimeout(down); };
  }, [rfqId]);

  return { snap, connected, now, version };
}

export function useCountdown(targetIso: string | Date | null | undefined, now: () => number) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  if (!targetIso) return null;
  return Math.max(0, Math.floor((Date.parse(String(targetIso)) - now()) / 1000));
}

export function fmtCountdown(sec: number | null): string {
  if (sec === null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}:${p(s)}`;
}
