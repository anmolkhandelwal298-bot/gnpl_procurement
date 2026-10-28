import { api, STAFF, uid } from "@/lib/http";
import { withUser } from "@/lib/db";
import { getComparisonMatrix } from "@/lib/services/auctions";

export const GET = api<{ id: string }>({ roles: STAFF }, async ({ user, params }) =>
  ({ rows: await withUser(user.id, (db) => getComparisonMatrix(db, uid(params.id))) }));
