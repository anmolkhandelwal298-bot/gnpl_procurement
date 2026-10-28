import { api, parseBody, uid } from "@/lib/http";
import { offerSchema } from "@/lib/validation";
import { saveOffer } from "@/lib/services/offers";

export const PUT = api<{ id: string }>({ roles: ["vendor"], limit: { name: "offer", max: 40, windowSec: 60 } }, async ({ req, user, params }) => {
  const input = await parseBody(req, offerSchema);
  return { offerId: await saveOffer(user, uid(params.id), input), submitted: input.submit };
});
