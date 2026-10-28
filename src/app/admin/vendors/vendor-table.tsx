"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Button, Card, DemoBadge, Empty, ReasonDialog, StatusBadge, Table, Td, Th } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export function VendorTable({ vendors, canEdit }: { vendors: any[]; canEdit: boolean }) {
  const router = useRouter();
  const [dlg, setDlg] = useState<{ v: any; status: "rejected" | "suspended" } | null>(null);
  const set = async (v: any, status: string, reason?: string) => { try { await apiFetch(`/api/vendors/${v.id}/status`, { body: { status, reason } }); router.refresh(); } catch (e: any) { alert(e.message); throw e; } };
  if (!vendors.length) return <Empty>No vendors match.</Empty>;
  return (
    <Card pad={false}>
      <Table><thead><tr><Th>Vendor</Th><Th>Contact</Th><Th>GSTIN</Th><Th>Location</Th><Th>Status</Th><Th>Activity</Th><Th>Registered</Th>{canEdit && <Th />}</tr></thead><tbody>
        {vendors.map((v) => (
          <tr key={v.id} className={v.status === "pending" ? "bg-amber-50/50" : ""}>
            <Td><span className="font-medium">{v.legal_name}</span>{v.is_demo && <DemoBadge />}<div className="text-xs text-navy-500">{v.vendor_code}</div></Td>
            <Td className="text-xs">{v.contact_name}<br />{v.contact_email}<br />{v.whatsapp_number ?? <span className="text-navy-400">no WhatsApp</span>}</Td>
            <Td className="font-mono text-xs">{v.gstin ?? "—"}</Td><Td className="text-xs">{[v.city, v.state].filter(Boolean).join(", ") || "—"}</Td>
            <Td><StatusBadge status={v.status} />{v.status_reason && <div className="mt-1 max-w-48 text-xs text-navy-500">{v.status_reason}</div>}</Td>
            <Td className="text-xs tabular">{v.invitations} invitations<br />{v.quotations} quotations</Td><Td className="text-xs">{fmtDateTime(v.created_at)}</Td>
            {canEdit && <Td><div className="flex flex-wrap gap-1.5">
              {["pending", "rejected", "suspended"].includes(v.status) && <Button size="sm" onClick={() => confirm(`Approve ${v.legal_name}? They can then be invited to RFQs.`) && set(v, "approved")}>{v.status === "pending" ? "Approve" : "Reinstate"}</Button>}
              {v.status === "pending" && <Button size="sm" variant="danger" onClick={() => setDlg({ v, status: "rejected" })}>Reject</Button>}
              {v.status === "approved" && <Button size="sm" variant="secondary" onClick={() => setDlg({ v, status: "suspended" })}>Suspend</Button>}
            </div></Td>}
          </tr>))}
      </tbody></Table>
      <ReasonDialog open={!!dlg} onClose={() => setDlg(null)} danger title={dlg ? `${dlg.status === "rejected" ? "Reject" : "Suspend"} ${dlg.v.legal_name}` : ""} confirmLabel={dlg?.status === "rejected" ? "Reject" : "Suspend"}
        onConfirm={async (reason) => { await set(dlg!.v, dlg!.status, reason); }}>
        {dlg?.status === "suspended" && <p className="mb-3 text-sm text-navy-600">A suspended vendor immediately loses the ability to see RFQs and place bids.</p>}</ReasonDialog>
    </Card>
  );
}
