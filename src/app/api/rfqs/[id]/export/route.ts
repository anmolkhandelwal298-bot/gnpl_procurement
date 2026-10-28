import { api, STAFF, uid } from "@/lib/http";
import { DomainError, q1, withUser } from "@/lib/db";
import { getBidHistory, getComparisonMatrix } from "@/lib/services/auctions";
import { getWorksheet } from "@/lib/services/allocations";
import { fileResponse, toCsv, toXlsx } from "@/lib/reports";
import { fmtDateTimeSec } from "@/lib/format";

const num = (v: any) => (v === null || v === undefined ? null : Number(v));

export const GET = api<{ id: string }>({ roles: STAFF, limit: { name: "export", max: 30, windowSec: 60 } }, async ({ req, user, params, ip }) => {
  const rfqId = uid(params.id);
  const sp = req.nextUrl.searchParams;
  const type = sp.get("type") ?? "matrix";
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  return withUser(user.id, async (db) => {
    const rfq = await q1<any>(db, "select rfq_number, is_demo, required_qty_mt from rfqs where id=$1", [rfqId]);
    if (!rfq) throw new DomainError("NOT_FOUND", "RFQ not found.", 404);
    let headers: string[], rows: any[][], sheet: string;
    if (type === "matrix") {
      const m = await getComparisonMatrix(db, rfqId);
      sheet = "Comparison matrix";
      headers = ["Rank", "Vendor", "Vendor ID", "Origin", "GCV (ARB) kcal/kg", "Total moisture %", "Ash %", "Quantity offered (MT)", "Initial FOR (₹/MT)", "Latest FOR (₹/MT)",
        "Reduction (₹/MT)", "Reduction %", "Technical qualification", "Auction participation", "Allocated qty (MT)", "Estimated award value (₹)"];
      rows = m.map((r) => [r.rank, r.legal_name, r.vendor_code, r.origin, r.gcv_arb, num(r.moisture_pct), num(r.ash_pct), num(r.qty_offered_mt), num(r.initial_for_price),
        num(r.latest_price), num(r.reduction), num(r.reduction_pct), r.qualification_status ?? "no quotation", r.participation, num(r.allocated_qty_mt), num(r.award_value)]);
    } else if (type === "bids") {
      const b = await getBidHistory(db, rfqId);
      sheet = "Bid history";
      headers = ["Seq", "Accepted at (server time)", "Vendor", "Vendor ID", "Bid (₹/MT)", "Previous (₹/MT)", "Reduction (₹/MT)", "Client IP"];
      rows = b.map((r) => [Number(r.seq), fmtDateTimeSec(r.accepted_at), r.legal_name, r.vendor_code, num(r.amount), num(r.previous_amount), num(r.reduction), r.client_ip]);
    } else if (type === "allocation") {
      const w = await getWorksheet(db, rfqId);
      sheet = "Allocation";
      headers = ["Rank", "Vendor", "Vendor ID", "Qualification", "Final FOR (₹/MT)", "Offered (MT)", "Allocated (MT)", "Estimated value (₹)", "Remarks"];
      rows = (w?.lines ?? []).map((l: any) => [l.rank, l.legal_name, l.vendor_code, l.qualification_status, num(l.current_price), num(l.qty_offered_mt), num(l.allocated_qty_mt), num(l.value), l.remarks]);
      rows.push(["", "TOTAL", "", "", "", "", w?.totalAllocated ?? 0, w?.totalValue ?? 0, `Requirement ${rfq.required_qty_mt} MT`]);
    } else throw new DomainError("BAD_REQUEST", "Unknown export type.", 400);
    await db.query("select write_audit('report.export','rfq',$1::text,$2::uuid,null,$3,null,null,$4::jsonb,$5)", [rfqId, rfqId, `Exported ${type} (${format})`, JSON.stringify({ type, format }), ip]);
    const banner = rfq.is_demo ? "DEMO DATA — not a real commercial record" : undefined;
    const name = `${rfq.rfq_number}-${type}${rfq.is_demo ? "-DEMO" : ""}`;
    return fileResponse(format, name, format === "csv" ? toCsv(headers, rows, banner) : await toXlsx(sheet, headers, rows, banner));
  });
});
