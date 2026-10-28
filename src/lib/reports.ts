import ExcelJS from "exceljs";

type Cell = string | number | boolean | Date | null | undefined;

const csvSafe = (v: Cell): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  let s = String(v);
  // Neutralise spreadsheet formula injection (a vendor-controlled string such as "=HYPERLINK(...)" must stay inert in Excel).
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(headers: string[], rows: Cell[][], banner?: string): string {
  const lines = [headers.map(csvSafe).join(",")];
  for (const r of rows) lines.push(r.map(csvSafe).join(","));
  return "﻿" + (banner ? csvSafe(banner) + "\n" : "") + lines.join("\n") + "\n";
}

export async function toXlsx(sheetName: string, headers: string[], rows: Cell[][], banner?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Grainspan Procurement Portal";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 30));
  let headerRow = 1;
  if (banner) {
    ws.addRow([banner]);
    ws.getRow(1).font = { bold: true, color: { argb: "FFB45309" } };
    headerRow = 2;
  }
  ws.addRow(headers);
  const hr = ws.getRow(headerRow);
  hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B2A4A" } };
  for (const r of rows) {
    const row = ws.addRow(r.map((v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? "'" + v : v ?? null)));
    row.eachCell((c) => { if (c.type === ExcelJS.ValueType.Formula) c.value = String(c.value); });
  }
  ws.columns.forEach((col, i) => { col.width = Math.min(48, Math.max(12, (headers[i]?.length ?? 10) + 4)); });
  ws.views = [{ state: "frozen", ySplit: headerRow }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function fileResponse(format: "csv" | "xlsx", name: string, body: string | Buffer): Response {
  const isCsv = format === "csv";
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": isCsv ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\w.\-]/g, "_")}.${format}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    },
  });
}
