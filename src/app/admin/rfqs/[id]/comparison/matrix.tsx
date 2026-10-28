"use client";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { useAuctionStream } from "@/lib/use-auction-stream";
import { Alert, Badge, Card, Input, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { inr, money, mt, pct } from "@/lib/format";

type Row = any;
const COLS: { key: string; label: string; num?: boolean; get?: (r: Row) => any }[] = [
  { key: "rank", label: "Rank", num: true }, { key: "legal_name", label: "Vendor" }, { key: "origin", label: "Origin" }, { key: "gcv_arb", label: "GCV (ARB)", num: true },
  { key: "moisture_pct", label: "Moisture %", num: true }, { key: "ash_pct", label: "Ash %", num: true }, { key: "qty_offered_mt", label: "Qty offered (MT)", num: true },
  { key: "initial_for_price", label: "Initial FOR (₹/MT)", num: true }, { key: "latest_price", label: "Latest FOR (₹/MT)", num: true }, { key: "reduction", label: "Reduction (₹/MT)", num: true },
  { key: "reduction_pct", label: "Reduction %", num: true }, { key: "qualification_status", label: "Technical qualification" }, { key: "participation", label: "Auction participation" },
  { key: "allocated_qty_mt", label: "Allocated (MT)", num: true }, { key: "award_value", label: "Est. award value (₹)", num: true },
];

export function Matrix({ rfqId, initial }: { rfqId: string; initial: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "rank", dir: 1 });
  const [text, setText] = useState(""); const [qual, setQual] = useState(""); const [part, setPart] = useState("");
  const { version, connected } = useAuctionStream<any>(rfqId, null);

  useEffect(() => { // refresh whenever the server pushes a change (bid, status, award)
    if (!version) return;
    apiFetch<{ rows: Row[] }>(`/api/rfqs/${rfqId}/matrix`).then((r) => setRows(r.rows)).catch(() => undefined);
  }, [version, rfqId]);

  const view = useMemo(() => {
    const t = text.toLowerCase();
    const f = rows.filter((r) => (!t || `${r.legal_name} ${r.vendor_code} ${r.origin ?? ""}`.toLowerCase().includes(t)) && (!qual || (r.qualification_status ?? "none") === qual) && (!part || r.participation === part));
    const col = COLS.find((c) => c.key === sort.key)!;
    return [...f].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;   // empty values always last
      return (col.num ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [rows, sort, text, qual, part]);
  const participations = Array.from(new Set(rows.map((r) => r.participation)));
  const total = rows.reduce((t, r) => t + Number(r.allocated_qty_mt ?? 0), 0), value = rows.reduce((t, r) => t + Number(r.award_value ?? 0), 0);
  const th = (c: (typeof COLS)[number]) => (
    <Th key={c.key} className={`cursor-pointer select-none ${c.num ? "text-right" : ""}`} onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (sort.dir === 1 ? -1 : 1) : 1 })} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {c.label} {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : <span className="text-navy-200">▲</span>}</Th>);

  return (
    <div className="space-y-4">
      <Alert tone="amber"><b>Confidential — procurement only.</b> Technical qualification is shown separately from price rank. Only qualified vendors are ranked, and the lowest price is <b>not</b> an automatic award.</Alert>
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search vendor, ID, origin" value={text} onChange={(e) => setText(e.target.value)} className="!w-64" />
        <Select value={qual} onChange={(e) => setQual(e.target.value)} className="!w-48"><option value="">All qualification</option><option value="qualified">Qualified</option><option value="disqualified">Disqualified</option><option value="pending">Pending</option><option value="none">No quotation</option></Select>
        <Select value={part} onChange={(e) => setPart(e.target.value)} className="!w-56"><option value="">All participation</option>{participations.map((p) => <option key={p}>{p}</option>)}</Select>
        <span className={`text-xs ${connected ? "text-emerald-700" : "text-amber-700"}`}>● {connected ? "live — updates automatically" : "connecting…"}</span>
        <div className="ml-auto flex gap-2">
          <a className="rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-800 hover:bg-navy-50" href={`/api/rfqs/${rfqId}/export?type=matrix&format=csv`}>⬇ CSV</a>
          <a className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-700" href={`/api/rfqs/${rfqId}/export?type=matrix&format=xlsx`}>⬇ Excel</a>
        </div>
      </div>
      <Card pad={false} className="[&_td]:px-2 [&_td]:text-[13px] [&_th]:px-2">
        <Table><thead><tr>{COLS.map(th)}</tr></thead><tbody>
          {view.map((r) => (
            <tr key={r.vendor_id} className="hover:bg-navy-50/50">
              <Td className="tabular">{r.rank ? <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${r.rank === 1 ? "bg-teal-600 text-white" : "bg-navy-100 text-navy-700"}`}>{r.rank}</span> : <span className="text-navy-300">—</span>}</Td>
              <Td><span className="font-medium">{r.legal_name}</span><div className="text-xs text-navy-500">{r.vendor_code}</div></Td>
              <Td>{r.origin ?? "—"}</Td><Td className="text-right tabular">{r.gcv_arb ?? "—"}</Td><Td className="text-right tabular">{r.moisture_pct ?? "—"}</Td><Td className="text-right tabular">{r.ash_pct ?? "—"}</Td>
              <Td className="text-right tabular">{mt(r.qty_offered_mt)}</Td><Td className="text-right tabular">{money(r.initial_for_price)}</Td>
              <Td className="text-right text-base font-bold tabular">{r.rank ? money(r.latest_price) : <span className="text-navy-300">—</span>}</Td>
              <Td className="text-right tabular">{r.rank && Number(r.reduction) > 0 ? money(r.reduction) : "—"}</Td><Td className="text-right tabular">{r.rank && Number(r.reduction_pct) > 0 ? pct(r.reduction_pct) : "—"}</Td>
              <Td>{r.qualification_status ? <StatusBadge status={r.qualification_status} /> : <Badge>no quotation</Badge>}{r.is_compliant === false && <Badge tone="red" className="ml-1">deviations</Badge>}</Td>
              <Td className="text-xs">{r.participation}</Td>
              <Td className="text-right tabular font-semibold">{Number(r.allocated_qty_mt) > 0 ? mt(r.allocated_qty_mt) : "—"}</Td>
              <Td className="text-right tabular">{Number(r.award_value) > 0 ? inr(r.award_value) : "—"}</Td>
            </tr>))}
          {!view.length && <tr><Td colSpan={COLS.length} className="py-6 text-center text-navy-500">No vendors match.</Td></tr>}
        </tbody>
        <tfoot><tr className="bg-navy-50/60 font-semibold"><Td colSpan={13} className="text-right text-xs uppercase text-navy-600">Totals (allocation)</Td><Td className="text-right tabular">{mt(total)} MT</Td><Td className="text-right tabular">{inr(value)}</Td></tr></tfoot></Table>
      </Card>
    </div>
  );
}
