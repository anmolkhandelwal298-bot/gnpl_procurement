export const emailConfigured = () => !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
export const whatsappConfigured = () => !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;

export function providerStatus() {
  return {
    email: { provider: "Resend", configured: emailConfigured(), missing: [!process.env.RESEND_API_KEY && "RESEND_API_KEY", !process.env.EMAIL_FROM && "EMAIL_FROM"].filter(Boolean) as string[],
      webhook: !!process.env.RESEND_WEBHOOK_SECRET },
    whatsapp: { provider: "WhatsApp Business Platform (Meta Cloud API)", configured: whatsappConfigured(),
      missing: [!process.env.WHATSAPP_ACCESS_TOKEN && "WHATSAPP_ACCESS_TOKEN", !process.env.WHATSAPP_PHONE_NUMBER_ID && "WHATSAPP_PHONE_NUMBER_ID"].filter(Boolean) as string[],
      webhook: !!process.env.WHATSAPP_APP_SECRET && !!process.env.WHATSAPP_VERIFY_TOKEN },
  };
}

export const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
