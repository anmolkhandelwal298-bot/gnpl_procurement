"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Table, Td, Th } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

const ROLES = { admin: "Administrator", procurement_manager: "Procurement manager", approver: "Approver" } as const;

export function UsersView({ users, me }: { users: any[]; me: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false); const [f, setF] = useState({ email: "", fullName: "", phone: "", role: "procurement_manager", password: "" });
  const [err, setErr] = useState(""); const [fe, setFe] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<any>(null); const [pw, setPw] = useState("");
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold text-navy-900">Staff users</h1><Button onClick={() => setOpen(true)}>+ Add user</Button></div>
      <Alert tone="blue">Roles: <b>Administrator</b> — everything incl. users and live-auction overrides · <b>Procurement manager</b> — RFQs, qualification, auctions, allocation drafts and submission · <b>Approver</b> — read access plus award approval and publication. New users must change their password at first sign-in.</Alert>
      <Card pad={false}><Table><thead><tr><Th>Name</Th><Th>E-mail</Th><Th>Role</Th><Th>Status</Th><Th>Last sign-in</Th><Th /></tr></thead><tbody>
        {users.map((u) => (
          <tr key={u.id}><Td className="font-medium">{u.full_name}</Td><Td>{u.email}</Td><Td>{ROLES[u.role as keyof typeof ROLES]}</Td><Td>{u.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Deactivated</Badge>}</Td><Td className="text-xs">{fmtDateTime(u.last_login_at)}</Td>
            <Td><div className="flex gap-1.5"><Button size="sm" variant="secondary" onClick={() => { setReset(u); setPw(""); setErr(""); }}>Reset password</Button>
              {u.id !== me && <Button size="sm" variant="ghost" onClick={async () => { try { await apiFetch(`/api/users/${u.id}/active`, { body: { active: !u.is_active } }); router.refresh(); } catch (e: any) { alert(e.message); } }}>{u.is_active ? "Deactivate" : "Reactivate"}</Button>}</div></Td></tr>))}
      </tbody></Table></Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add staff user">
        {err && <div className="mb-3"><Alert>{err}</Alert></div>}
        <div className="space-y-3">
          <Field label="Full name" error={fe.fullName}><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
          <Field label="E-mail" error={fe.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role" error={fe.role}><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Temporary password" error={fe.password} hint="At least 10 characters with a letter and number. The user must change it at first sign-in."><Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button busy={busy} onClick={async () => { setBusy(true); setErr(""); setFe({}); try { await apiFetch("/api/users", { body: f }); setOpen(false); router.refresh(); } catch (x) { const a = x as ApiError; setErr(a.message); setFe(a.fields); } finally { setBusy(false); } }}>Create user</Button></div>
      </Modal>
      <Modal open={!!reset} onClose={() => setReset(null)} title={`Reset password — ${reset?.full_name ?? ""}`}>
        {err && <div className="mb-3"><Alert>{err}</Alert></div>}
        <Field label="New temporary password" hint="All of the user's sessions are signed out and they must change it at next sign-in."><Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setReset(null)}>Cancel</Button>
          <Button onClick={async () => { try { await apiFetch(`/api/users/${reset.id}/reset-password`, { body: { password: pw } }); setReset(null); } catch (x: any) { setErr(x.fields?.password ?? x.message); } }}>Reset</Button></div>
      </Modal>
    </div>
  );
}
