import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { tick } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

// For external schedulers (Vercel Cron, GitHub Actions, uptime pingers). Idempotent; the in-process scheduler does the same work.
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await tick());
}
export const GET = handle;
export const POST = handle;
