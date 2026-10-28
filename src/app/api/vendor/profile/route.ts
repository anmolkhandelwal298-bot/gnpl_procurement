import { api, parseBody } from "@/lib/http";
import { vendorProfileSchema } from "@/lib/validation";
import { updateOwnProfile } from "@/lib/services/vendors";

export const PUT = api({ roles: ["vendor"] }, async ({ req, user }) => { await updateOwnProfile(user, await parseBody(req, vendorProfileSchema)); return { ok: true }; });
