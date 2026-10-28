import { api, uid } from "@/lib/http";
import { DomainError } from "@/lib/db";
import { MAX_DOC_BYTES, uploadDocument } from "@/lib/services/offers";

export const POST = api<{ id: string }>({ roles: ["vendor"], limit: { name: "upload", max: 20, windowSec: 300 } }, async ({ req, user, params }) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_DOC_BYTES + 64 * 1024) throw new DomainError("FILE_TOO_LARGE", "Files may be at most 10 MB.", 413);
  const form = await req.formData();
  const file = form.get("file");
  const docType = form.get("docType") === "supporting" ? "supporting" : "coa";
  if (!(file instanceof File)) throw new DomainError("VALIDATION", "Choose a file to upload.", 400);
  const doc = await uploadDocument(user, uid(params.id), docType, file.name, Buffer.from(await file.arrayBuffer()));
  return { document: doc };
});
