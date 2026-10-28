import { fmtDateTime, inr, mt } from "../format";
import { appUrl } from "./config";

export type NotifKind =
  | "rfq_invitation" | "quotation_reminder" | "auction_open" | "auction_closing_reminder" | "auction_closed" | "award" | "non_award";

export const KIND_LABEL: Record<NotifKind, string> = {
  rfq_invitation: "RFQ invitation", quotation_reminder: "Quotation deadline reminder", auction_open: "Auction opening",
  auction_closing_reminder: "Auction closing reminder", auction_closed: "Auction closed", award: "Award / quantity allocation", non_award: "Non-award",
};

/** Everything a template needs. Strictly per-vendor data: never another vendor's name, price or quantity. */
export interface NotifPayload {
  vendor_name: string;
  rfq_id: string;
  rfq_number: string;
  material: string;
  required_qty_mt?: string;
  quotation_deadline?: string;
  auction_start?: string;
  auction_end?: string;
  delivery_location?: string;
  allocated_qty_mt?: string;
  final_price?: string;
  value?: string;
  hours_left?: string;
}

const link = (p: NotifPayload) => `${appUrl()}/vendor/rfqs/${p.rfq_id}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function shell(title: string, bodyHtml: string, cta: string, url: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f3f6f9;font-family:Segoe UI,Arial,sans-serif;color:#13233a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #dbe3ec">
<tr><td style="background:#0b2a4a;color:#fff;padding:18px 24px;font-size:16px;font-weight:600">Grainspan Nutrients — Procurement Portal</td></tr>
<tr><td style="padding:24px"><h2 style="margin:0 0 12px;font-size:18px;color:#0b2a4a">${esc(title)}</h2>${bodyHtml}
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#0f8b8d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;display:inline-block">${esc(cta)}</a></p>
<p style="font-size:12px;color:#5b6b80;margin:0">You are receiving this because your company is registered as a supplier with Grainspan Nutrients Private Limited. Sign in to the portal to act on this notice; this message does not contain confidential commercial data.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const rows = (pairs: [string, string | undefined][]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;margin:8px 0">${pairs.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:5px 0;color:#5b6b80;width:42%">${esc(k)}</td><td style="padding:5px 0;font-weight:600">${esc(v!)}</td></tr>`).join("")}</table>`;

export function renderEmail(kind: NotifKind, p: NotifPayload): { subject: string; html: string; text: string } {
  const ref = `${p.rfq_number} — ${p.material}`;
  const url = link(p);
  const common: [string, string | undefined][] = [["RFQ", p.rfq_number], ["Material", p.material]];
  let subject: string, intro: string, details: [string, string | undefined][], cta: string;
  switch (kind) {
    case "rfq_invitation":
      subject = `Invitation to quote: ${ref}`;
      intro = `Dear ${p.vendor_name}, Grainspan Nutrients invites you to submit a quotation and take part in a live reverse auction.`;
      details = [...common, ["Required quantity", p.required_qty_mt && `${mt(p.required_qty_mt)} MT`], ["Delivery", p.delivery_location],
        ["Quotation deadline", fmtDateTime(p.quotation_deadline)], ["Auction", `${fmtDateTime(p.auction_start)} – ${fmtDateTime(p.auction_end)}`]];
      cta = "Open RFQ in portal"; break;
    case "quotation_reminder":
      subject = `Reminder: quotation due ${fmtDateTime(p.quotation_deadline)} — ${ref}`;
      intro = `Dear ${p.vendor_name}, we have not yet received your submitted quotation for this RFQ. The deadline is approaching${p.hours_left ? ` (about ${p.hours_left} h left)` : ""}.`;
      details = [...common, ["Quotation deadline", fmtDateTime(p.quotation_deadline)]]; cta = "Submit quotation"; break;
    case "auction_open":
      subject = `Auction is LIVE: ${ref}`;
      intro = `Dear ${p.vendor_name}, the reverse auction is now open. You can revise your FOR price until it closes.`;
      details = [...common, ["Auction closes", fmtDateTime(p.auction_end)]]; cta = "Join the auction"; break;
    case "auction_closing_reminder":
      subject = `Auction closing soon: ${ref}`;
      intro = `Dear ${p.vendor_name}, the auction closes shortly. Submit any final price revision now.`;
      details = [...common, ["Auction closes", fmtDateTime(p.auction_end)]]; cta = "Go to auction"; break;
    case "auction_closed":
      subject = `Auction closed: ${ref}`;
      intro = `Dear ${p.vendor_name}, the auction has closed and no further bids are accepted. Grainspan will communicate the outcome after evaluation.`;
      details = common; cta = "View RFQ"; break;
    case "award":
      subject = `Award notice: ${ref}`;
      intro = `Dear ${p.vendor_name}, Grainspan Nutrients is pleased to confirm the following allocation. A purchase order will follow separately.`;
      details = [...common, ["Allocated quantity", p.allocated_qty_mt && `${mt(p.allocated_qty_mt)} MT`], ["Accepted FOR price", p.final_price && `${inr(p.final_price)} / MT`],
        ["Estimated value", p.value && inr(p.value)]];
      cta = "View award"; break;
    case "non_award":
      subject = `Outcome of RFQ ${p.rfq_number}`;
      intro = `Dear ${p.vendor_name}, thank you for participating. On this occasion no quantity has been allocated to your company for this RFQ. We value your participation and look forward to future opportunities.`;
      details = common; cta = "View RFQ"; break;
  }
  const html = shell(subject, `<p style="font-size:14px;line-height:1.55">${esc(intro)}</p>${rows(details)}`, cta, url);
  const text = `${intro}\n\n${details.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${cta}: ${url}\n\n— Grainspan Nutrients Private Limited`;
  return { subject, html, text };
}

/** WhatsApp template: name from env + ordered body variables ({{1}}, {{2}}, ...). See docs/NOTIFICATIONS.md for the approved wording. */
export function whatsappTemplate(kind: NotifKind, p: NotifPayload): { name: string; params: string[] } {
  const env = (k: string, d: string) => process.env[k] || d;
  const base = [p.vendor_name, p.rfq_number, p.material];
  switch (kind) {
    case "rfq_invitation":
      return { name: env("WHATSAPP_TEMPLATE_RFQ_INVITATION", "gnpl_rfq_invitation"),
        params: [...base, `${mt(p.required_qty_mt)} MT`, fmtDateTime(p.quotation_deadline), link(p)] };
    case "quotation_reminder":
      return { name: env("WHATSAPP_TEMPLATE_QUOTATION_REMINDER", "gnpl_quotation_reminder"), params: [...base, fmtDateTime(p.quotation_deadline), link(p)] };
    case "auction_open":
      return { name: env("WHATSAPP_TEMPLATE_AUCTION_OPEN", "gnpl_auction_open"), params: [...base, fmtDateTime(p.auction_end), link(p)] };
    case "auction_closing_reminder":
      return { name: env("WHATSAPP_TEMPLATE_AUCTION_CLOSING", "gnpl_auction_closing"), params: [...base, fmtDateTime(p.auction_end), link(p)] };
    case "auction_closed":
      return { name: env("WHATSAPP_TEMPLATE_AUCTION_CLOSED", "gnpl_auction_closed"), params: [...base, link(p)] };
    case "award":
      return { name: env("WHATSAPP_TEMPLATE_AWARD", "gnpl_award"), params: [...base, `${mt(p.allocated_qty_mt)} MT`, `${inr(p.final_price)} / MT`, link(p)] };
    case "non_award":
      return { name: env("WHATSAPP_TEMPLATE_NON_AWARD", "gnpl_non_award"), params: [...base, link(p)] };
  }
}
