import { api } from "@/lib/http";
import { listVendorRfqs } from "@/lib/services/offers";

export const GET = api({ roles: ["vendor"] }, async ({ user }) => ({ rfqs: await listVendorRfqs(user.id) }));
