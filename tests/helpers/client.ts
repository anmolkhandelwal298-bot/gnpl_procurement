import { BASE } from "./stack";

export interface StreamHandle {
  status: number; events: { event: string; data: any; at: number }[]; close: () => void;
  waitFor: (pred: (s: any) => boolean, timeoutMs?: number, from?: number) => Promise<{ event: string; data: any; at: number }>;
}
export interface Res<T = any> { status: number; json: T; headers: Headers; setCookie: string | null }

/** Minimal browser-like HTTP client: keeps the session cookie and sends a same-origin Origin header. */
export class Client {
  cookie = "";
  constructor(public label = "client") {}
  async req<T = any>(method: string, path: string, body?: unknown, opts: { headers?: Record<string, string>; form?: FormData; noOrigin?: boolean } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (!opts.noOrigin && method !== "GET" && !headers.origin) headers.origin = BASE;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(BASE + path, { method, headers, body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: "manual" });
    const sc = r.headers.get("set-cookie");
    if (sc) { const m = /gnpl_session=([^;]*)/.exec(sc); if (m) this.cookie = m[1] ? `gnpl_session=${m[1]}` : ""; }
    const text = await r.text();
    let json: any = text; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, headers: r.headers, setCookie: sc };
  }
  get = <T = any>(p: string, o?: any) => this.req<T>("GET", p, undefined, o);
  post = <T = any>(p: string, b: unknown = {}, o?: any) => this.req<T>("POST", p, b, o);
  put = <T = any>(p: string, b: unknown, o?: any) => this.req<T>("PUT", p, b, o);
  del = <T = any>(p: string, o?: any) => this.req<T>("DELETE", p, undefined, o);
  async login(email: string, password = "Demo@12345") {
    const r = await this.post("/api/auth/login", { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  }
  /** Opens the SSE stream and records every snapshot. */
  async stream(rfqId: string): Promise<StreamHandle> {
    const ctl = new AbortController();
    const events: { event: string; data: any; at: number }[] = [];
    const res = await fetch(`${BASE}/api/rfqs/${rfqId}/stream`, { headers: { cookie: this.cookie }, signal: ctl.signal });
    if (res.status !== 200) { ctl.abort(); return { status: res.status, events, close: () => undefined, waitFor: async () => { throw new Error("no stream"); } }; }
    (async () => {
      const dec = new TextDecoder(); let buf = "";
      try {
        for await (const chunk of res.body as any) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(frame)?.[1]; const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (ev && data) events.push({ event: ev, data: JSON.parse(data), at: Date.now() });
          }
        }
      } catch { /* aborted */ }
    })();
    return {
      status: 200, events, close: () => ctl.abort(),
      async waitFor(pred: (s: any) => boolean, timeoutMs = 8000, from = 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const hit = events.slice(from).find((e) => e.event === "snapshot" && pred(e.data));
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error("timed out waiting for stream snapshot; last: " + JSON.stringify(events.at(-1)?.data)?.slice(0, 400));
      },
    };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => Promise<T | null | false | undefined>, timeoutMs = 10000, everyMs = 150): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out in until()");
    await sleep(everyMs);
  }
}
