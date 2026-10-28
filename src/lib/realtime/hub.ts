import { Client } from "pg";

export interface HubMessage { auction_id: string; rfq_id: string; kind: string; seq?: number }
type Listener = (m: HubMessage | { kind: "resync"; rfq_id?: string }) => void;

/**
 * One dedicated Postgres connection per server process LISTENs on the `auction_events` channel (fired by place_bid and by the
 * lifecycle code, i.e. only after the transaction COMMITS) and fans messages out to in-process SSE subscribers, keyed by RFQ.
 * Messages carry no price data: every subscriber re-reads its own, role-filtered snapshot from the database.
 */
class Hub {
  private subs = new Map<string, Set<Listener>>();
  private client: Client | null = null;
  private starting = false;
  private retry = 1000;
  private keepalive: NodeJS.Timeout | null = null;

  subscribe(rfqId: string, fn: Listener): () => void {
    void this.start();
    let set = this.subs.get(rfqId);
    if (!set) this.subs.set(rfqId, (set = new Set()));
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.subs.delete(rfqId); };
  }

  private emit(m: HubMessage | { kind: "resync"; rfq_id?: string }) {
    if (m.kind === "resync" && !m.rfq_id) { for (const s of this.subs.values()) for (const f of s) f(m); return; }
    for (const f of this.subs.get((m as HubMessage).rfq_id ?? (m as any).rfq_id) ?? []) f(m);
  }

  async start() {
    if (this.client || this.starting) return;
    this.starting = true;
    try {
      const c = new Client({
        connectionString: process.env.DATABASE_URL_LISTEN || process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL && process.env.DATABASE_SSL !== "false" ? { rejectUnauthorized: process.env.DATABASE_SSL !== "no-verify" } : undefined,
        application_name: "grainspan-realtime",
      });
      c.on("notification", (n) => {
        try { this.emit(JSON.parse(n.payload ?? "{}")); } catch { /* ignore malformed */ }
      });
      const lost = (why: string) => {
        if (this.client !== c) return;
        console.error("[realtime] listener connection lost:", why);
        this.client = null;
        if (this.keepalive) clearInterval(this.keepalive);
        setTimeout(() => void this.start().then(() => this.emit({ kind: "resync" })), this.retry);
        this.retry = Math.min(this.retry * 2, 15_000);
      };
      c.on("error", (e) => lost(e.message));
      c.on("end", () => lost("ended"));
      await c.connect();
      await c.query("LISTEN auction_events");
      this.client = c;
      this.retry = 1000;
      this.keepalive = setInterval(() => c.query("select 1").catch(() => undefined), 30_000);
    } catch (e: any) {
      console.error("[realtime] cannot start listener:", e.message);
      setTimeout(() => void this.start(), this.retry);
      this.retry = Math.min(this.retry * 2, 15_000);
    } finally {
      this.starting = false;
    }
  }
}

const g = globalThis as unknown as { __gnplHub?: Hub };
export const hub = (): Hub => (g.__gnplHub ??= new Hub());
