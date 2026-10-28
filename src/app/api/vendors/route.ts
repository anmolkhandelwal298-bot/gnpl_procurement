import { api, STAFF } from "@/lib/http";
import { listVendors } from "@/lib/services/vendors";

export const GET = api({ roles: STAFF }, async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  return { vendors: await listVendors(user.id, { status: sp.get("status") ?? undefined, search: sp.get("search") ?? undefined }) };
});
