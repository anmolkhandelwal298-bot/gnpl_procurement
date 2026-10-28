import type { NextRequest } from "next/server";
import { hub } from "@/lib/realtime/hub";
import { buildSnapshot } from "@/lib/services/snapshot";
import { resolveToken, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-Sent Events: pushes a freshly computed, viewer-specific snapshot whenever the auction changes in the database. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: rfqId } = await ctx.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = UUID.test(rfqId) ? await resolveToken(token) : null;
  if (!user) return new Response("Unauthorized", { status: 401 });
  const first = await buildSnapshot(user, rfqId);
  if (!first) return new Response("Not found", { status: 404 });

  const enc = new TextEncoder();
  let closed = false;
  const cleanups: (() => void)[] = [];

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
      };
      const close = () => { if (closed) return; closed = true; cleanups.forEach((f) => f()); try { controller.close(); } catch { /* already closed */ } };

      controller.enqueue(enc.encode("retry: 2000\n\n"));
      send("snapshot", first);

      // coalesce bursts of events into at most one snapshot per ~120 ms
      let timer: NodeJS.Timeout | null = null, running = false, again = false;
      const push = async () => {
        if (running) { again = true; return; }
        running = true;
        try { const s = await buildSnapshot(user, rfqId); if (s) send("snapshot", s); }
        catch (e: any) { console.error("[sse] snapshot failed:", e?.message); }
        finally { running = false; if (again) { again = false; void push(); } }
      };
      const unsub = hub().subscribe(rfqId, () => { if (!timer) timer = setTimeout(() => { timer = null; void push(); }, 120); });
      cleanups.push(unsub, () => timer && clearTimeout(timer));

      const hb = setInterval(async () => {
        send("ping", { t: new Date().toISOString() });
        // keep honouring session expiry / revocation on long-lived streams
        const still = await resolveToken(token).catch(() => null);
        if (!still) { send("auth", { error: "session_expired" }); close(); }
      }, 15_000);
      cleanups.push(() => clearInterval(hb));

      req.signal.addEventListener("abort", close);
    },
    cancel() { closed = true; cleanups.forEach((f) => f()); },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
