import { api, uid } from "@/lib/http";
import { withdrawOffer } from "@/lib/services/offers";

export const POST = api<{ id: string }>({ roles: ["vendor"] }, async ({ user, params }) => { await withdrawOffer(user, uid(params.id)); return { ok: true }; });
