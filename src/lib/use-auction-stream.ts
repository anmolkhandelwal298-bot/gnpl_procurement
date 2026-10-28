"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One EventSource per RFQ per browser tab, shared by every component that needs it (browsers allow only ~6 HTTP/1.1 connections per host).
 * The server pushes a complete, role-filtered snapshot after every committed change; if the stream is down for a few seconds we fall back
 * to polling /snapshot. The synchronised clock (`now()`) is used ONLY for display — the server alone decides whether a bid is on time.
 */
type Snap = { serverTime: string | Date; [k: string]: any };
interface Conn {
  refs: number; es: EventSource | null; last: Snap | null; connected: boolean; offset: number;
  subs: Set<() => void>; poll: ReturnType<typeof setInterval> | null; down: ReturnType<typeof setTimeout> | null; closeTimer: ReturnType<typeof setTimeout> | null;
}
const conns = new Map<string, Conn>();

function emit(c: Conn) { c.subs.forEach((f) => f()); }
function apply(c: Conn, s: Snap) { c.offset = Date.parse(String(s.serverTime)) - Date.now(); c.last = s; emit(c); }

function open(rfqId: string): Conn {
  const c: Conn = { refs: 0, es: null, last: null, connected: false, offset: 0, subs: new Set(), poll: null, down: null, closeTimer: null };
  const startPolling = () => {
    if (c.poll) return;
    c.poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/rfqs/${rfqId}/snapshot`, { cache: "no-store" });
        if (r.ok) apply(c, await r.json()); else if (r.status === 401) window.location.href = "/login?expired=1";
      } catch { /* retry */ }
    }, 3000);
  };
  const es = new EventSource(`/api/rfqs/${rfqId}/stream`);
  c.es = es;
  es.addEventListener("snapshot", (e) => {
    c.connected = true;
    if (c.poll) { clearInterval(c.poll); c.poll = null; }
    if (c.down) { clearTimeout(c.down); c.down = null; }
    apply(c, JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("auth", () => { window.location.href = "/login?expired=1"; });
  es.onerror = () => { c.connected = false; emit(c); if (!c.down) c.down = setTimeout(startPolling, 6000); };
  return c;
}

export function useAuctionStream<T extends Snap>(rfqId: string, initial: T | null) {
  const [, force] = useState(0);
  const connRef = useRef<Conn | null>(null);
  const initialRef = useRef(initial);

  useEffect(() => {
    let c = conns.get(rfqId);
    if (!c) { c = open(rfqId); conns.set(rfqId, c); }
    if (c.closeTimer) { clearTimeout(c.closeTimer); c.closeTimer = null; }
    c.refs++;
    connRef.current = c;
    const sub = () => force((n) => n + 1);
    c.subs.add(sub);
    if (!c.last && initialRef.current) { c.offset = Date.parse(String(initialRef.current.serverTime)) - Date.now(); }
    sub();
    return () => {
      c!.subs.delete(sub); c!.refs--;
      if (c!.refs <= 0) {                                                  // keep the connection a moment so route changes don't reconnect
        c!.closeTimer = setTimeout(() => { if (c!.refs > 0) return; c!.es?.close(); if (c!.poll) clearInterval(c!.poll); if (c!.down) clearTimeout(c!.down); conns.delete(rfqId); }, 3000);
      }
    };
  }, [rfqId]);

  const c = connRef.current;
  const snap = (c?.last as T | null) ?? initialRef.current;
  const now = useCallback(() => Date.now() + (connRef.current?.offset ?? 0), []);
  /** Pull a fresh snapshot right now (used at countdown zero so the UI never waits for the next push). */
  const refresh = useCallback(async () => {
    try { const r = await fetch(`/api/rfqs/${rfqId}/snapshot`, { cache: "no-store" }); if (r.ok && connRef.current) apply(connRef.current, await r.json()); } catch { /* the stream will catch up */ }
  }, [rfqId]);
  return { snap, connected: !!c?.connected, now, version: c?.last ? Date.parse(String(c.last.serverTime)) : 0, refresh };
}

/** Keeps server-rendered parts of an RFQ page (header badge, action buttons) in step with stage changes pushed by the server. */
export function RfqStatusSync({ rfqId, initialStatus }: { rfqId: string; initialStatus: string }) {
  const router = useRouter();
  const { snap } = useAuctionStream<any>(rfqId, null);
  const last = useRef(initialStatus);
  const status: string | undefined = snap?.rfq?.status;
  useEffect(() => { if (status && status !== last.current) { last.current = status; router.refresh(); } }, [status, router]);
  return null;
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
