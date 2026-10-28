import { api, uid } from "@/lib/http";
import { DomainError } from "@/lib/db";
import { readDocument, removeDocument } from "@/lib/services/offers";

// Authorisation is enforced by RLS: a vendor can read only their own documents, staff can read all; everyone else gets 404.
export const GET = api<{ id: string }>({}, async ({ user, params, ip }) => {
  const d = await readDocument(user, uid(params.id), ip);
  if (!d) throw new DomainError("NOT_FOUND", "Document not found.", 404);
  return new Response(new Uint8Array(d.content), {
    headers: {
      "Content-Type": d.mime_type, "Content-Disposition": `attachment; filename="${d.filename.replace(/[^\w.\- ()]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
export const DELETE = api<{ id: string }>({ roles: ["vendor"] }, async ({ user, params }) => { await removeDocument(user, uid(params.id)); return { ok: true }; });
