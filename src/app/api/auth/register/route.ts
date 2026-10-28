import { api, parseBody } from "@/lib/http";
import { registerVendorSchema } from "@/lib/validation";
import { registerVendor } from "@/lib/services/vendors";

export const POST = api({ public: true, limit: { name: "register", max: 5, windowSec: 3600, perIp: true } }, async ({ req }) => {
  const input = await parseBody(req, registerVendorSchema);
  await registerVendor(input);
  return { ok: true, message: "Registration received. Grainspan procurement will review and approve your company before you can be invited to RFQs." };
});
