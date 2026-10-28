import { api, parseBody } from "@/lib/http";
import { staffUserSchema } from "@/lib/validation";
import { createStaff, listStaff } from "@/lib/services/vendors";

export const GET = api({ roles: ["admin"] }, async ({ user }) => ({ users: await listStaff(user.id) }));
export const POST = api({ roles: ["admin"], limit: { name: "user-create", max: 20, windowSec: 60 } }, async ({ req, user }) => ({ id: await createStaff(user, await parseBody(req, staffUserSchema)) }));
