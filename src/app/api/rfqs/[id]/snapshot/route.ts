import { api, uid } from "@/lib/http";
import { DomainError } from "@/lib/db";
import { buildSnapshot } from "@/lib/services/snapshot";

// Polling fallback for clients that cannot hold an SSE connection. Same role-filtered data as the stream.
export const GET = api<{ id: string }>({ limit: { name: "snapshot", max: 120, windowSec: 60 } }, async ({ user, params }) => {
  const s = await buildSnapshot(user, uid(params.id));
  if (!s) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
  return s;
});
