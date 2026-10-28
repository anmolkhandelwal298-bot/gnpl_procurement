import { api, parseBody, STAFF, EDITORS, uid } from "@/lib/http";
import { allocationSchema } from "@/lib/validation";
import { getWorksheet, saveAllocations } from "@/lib/services/allocations";
import { withUser } from "@/lib/db";

export const GET = api<{ id: string }>({ roles: STAFF }, async ({ user, params }) => withUser(user.id, async (db) => (await getWorksheet(db, uid(params.id))) ?? { rfq: null }));
export const PUT = api<{ id: string }>({ roles: EDITORS, limit: { name: "alloc", max: 60, windowSec: 60 } }, async ({ req, user, params }) => {
  const { lines } = await parseBody(req, allocationSchema);
  return saveAllocations(user, uid(params.id), lines);
});
