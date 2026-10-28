import { whatsappConfigured } from "./config";
import type { SendResult } from "./email";

// Meta error codes that are transient (throughput / pair rate limits / temporary outage)
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131056, 133016]);

/** Sends an approved *template* message through the WhatsApp Business Cloud API (business-initiated messages must use templates). */
export async function sendWhatsAppTemplate(toE164: string, template: string, params: string[]): Promise<SendResult> {
  if (!whatsappConfigured()) return { ok: false, notConfigured: true, error: "WhatsApp provider not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)" };
  const version = process.env.WHATSAPP_API_VERSION || "v21.0";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`${process.env.WHATSAPP_API_BASE || "https://graph.facebook.com"}/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toE164.replace(/^\+/, ""),
        type: "template",
        template: {
          name: template,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: text.replace(/[\n\t]+/g, " ").slice(0, 1000) })) }],
        },
      }),
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number; error_data?: { details?: string } } };
    const id = body.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, messageId: id };
    const code = body.error?.code;
    const retryable = res.status === 429 || res.status >= 500 || (code !== undefined && RETRYABLE_CODES.has(code));
    return { ok: false, retryable, error: `WhatsApp ${res.status}${code ? ` (code ${code})` : ""}: ${body.error?.error_data?.details ?? body.error?.message ?? "request failed"}` };
  } catch (e: any) {
    return { ok: false, retryable: true, error: `WhatsApp request failed: ${e?.name === "AbortError" ? "timeout" : e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}
