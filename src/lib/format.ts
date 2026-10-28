// Isomorphic formatting helpers (used by server and client components). All timestamps are stored UTC and shown in APP_TIMEZONE.
export const TZ = process.env.NEXT_PUBLIC_APP_TIMEZONE || process.env.APP_TIMEZONE || "Asia/Kolkata";
const TZ_LABEL = TZ === "Asia/Kolkata" ? "IST" : TZ;

const num2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num3 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const dt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const dts = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export const inr = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : "₹" + num2.format(Number(v)));
export const money = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : num2.format(Number(v)));
export const mt = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : num3.format(Number(v)));
export const pct = (v: number | string | null | undefined, d = 2) => (v === null || v === undefined || v === "" ? "—" : Number(v).toFixed(d) + "%");
export const fmtDateTime = (d: Date | string | null | undefined) => (d ? `${dt.format(new Date(d))} ${TZ_LABEL}` : "—");
export const fmtDateTimeSec = (d: Date | string | null | undefined) => (d ? `${dts.format(new Date(d))} ${TZ_LABEL}` : "—");

/** Value for <input type="datetime-local"> showing `d` in the app timezone. */
export function toLocalInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
  return parts.replace(" ", "T");
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", published: "Published", quotation_open: "Quotation open", qualification: "Qualification", scheduled: "Auction scheduled",
  live: "Live auction", closed: "Auction closed", cancelled: "Cancelled", awarded: "Awarded",
};
