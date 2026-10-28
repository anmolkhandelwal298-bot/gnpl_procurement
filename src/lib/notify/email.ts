import { emailConfigured } from "./config";

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; retryable: boolean; error: string }
  | { ok: false; notConfigured: true; error: string };

/** Sends through the Resend REST API. `idempotencyKey` (the notification id) makes retries safe: Resend de-duplicates for 24 h. */
export async function sendEmail(to: string, subject: string, html: string, text: string, idempotencyKey: string): Promise<SendResult> {
  if (!emailConfigured()) return { ok: false, notConfigured: true, error: "Email provider not configured (set RESEND_API_KEY and EMAIL_FROM)" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text }),
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (res.ok && body.id) return { ok: true, messageId: body.id };
    const retryable = res.status === 429 || res.status >= 500;
    return { ok: false, retryable, error: `Resend ${res.status}: ${body.message ?? body.name ?? "request failed"}` };
  } catch (e: any) {
    return { ok: false, retryable: true, error: `Resend request failed: ${e?.name === "AbortError" ? "timeout" : e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}
