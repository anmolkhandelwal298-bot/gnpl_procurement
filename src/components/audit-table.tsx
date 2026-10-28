"use client";
import { Fragment, useState } from "react";
import { Badge, Card, Empty, Table, Td, Th } from "@/components/ui";
import { fmtDateTimeSec } from "@/lib/format";

export function AuditTable({ rows, exportHref }: { rows: any[]; exportHref?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!rows.length) return <Empty>No audit entries.</Empty>;
  return (
    <Card pad={false} title={`Audit entries (${rows.length}${rows.length >= 300 ? "+" : ""})`}
      actions={exportHref && <><a className="text-sm font-semibold text-teal-700 hover:underline" href={`${exportHref}&format=csv`}>CSV</a><a className="text-sm font-semibold text-teal-700 hover:underline" href={`${exportHref}&format=xlsx`}>Excel</a></>}>
      <Table><thead><tr><Th>#</Th><Th>Time (server)</Th><Th>Actor</Th><Th>Action</Th><Th>Summary / change</Th><Th /></tr></thead><tbody>
        {rows.map((r) => (
          <Fragment key={r.id}>
            <tr className="hover:bg-navy-50/50">
              <Td className="tabular text-xs text-navy-500">{r.chain_seq}</Td><Td className="whitespace-nowrap text-xs tabular">{fmtDateTimeSec(r.created_at)}</Td>
              <Td>{r.actor_name ?? <span className="text-navy-400">system</span>}{r.actor_role && <Badge className="ml-1.5">{r.actor_role.replace("procurement_", "")}</Badge>}</Td>
              <Td className="font-mono text-xs">{r.action}</Td>
              <Td className="max-w-md text-xs text-navy-600">{r.summary ?? (r.after ? Object.entries(r.after).slice(0, 3).map(([k, v]) => `${k}: ${short(v)}`).join(" · ") : "")}</Td>
              <Td>{(r.before || r.after) && <button className="text-xs font-semibold text-teal-700 hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "hide" : "diff"}</button>}</Td>
            </tr>
            {open === r.id && (
              <tr><Td colSpan={6} className="bg-navy-50/60">
                <div className="grid gap-3 text-xs sm:grid-cols-2"><pre className="overflow-x-auto rounded bg-white p-2"><b>Before</b>{"\n"}{JSON.stringify(r.before, null, 2)}</pre><pre className="overflow-x-auto rounded bg-white p-2"><b>After</b>{"\n"}{JSON.stringify(r.after, null, 2)}</pre></div>
                {r.ip && <p className="mt-1 text-xs text-navy-500">IP {r.ip}</p>}
              </Td></tr>)}
          </Fragment>))}
      </tbody></Table>
    </Card>
  );
}
const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 40 ? s.slice(0, 40) + "…" : s; };
