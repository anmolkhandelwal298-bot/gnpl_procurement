"use client";
import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { STATUS_LABEL } from "@/lib/format";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("rounded-xl border border-navy-100 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-navy-100 px-5 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-700">{title}</h2>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? "p-5" : ""}>{children}</div>
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" | "lg"; busy?: boolean };
export function Button({ variant = "primary", size = "md", busy, className, children, disabled, ...rest }: BtnProps) {
  const v = {
    primary: "bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-600/50",
    secondary: "bg-white text-navy-800 border border-navy-200 hover:bg-navy-50 disabled:text-navy-300",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50",
    ghost: "text-navy-700 hover:bg-navy-50",
  }[variant];
  const s = { sm: "px-2.5 py-1 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" }[size];
  return (
    <button {...rest} disabled={disabled || busy} className={cx("inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition disabled:cursor-not-allowed", v, s, className)}>
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block text-sm", className)}>
      <span className="mb-1 block font-medium text-navy-800">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-navy-500">{hint}</span>}
      {error && <span role="alert" className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm text-navy-900 placeholder:text-navy-300 focus:border-teal-500 disabled:bg-navy-50 disabled:text-navy-500";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, p.className)} />;

const TONES: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200", red: "bg-red-50 text-red-800 ring-red-200", amber: "bg-amber-50 text-amber-800 ring-amber-200",
  blue: "bg-navy-50 text-navy-700 ring-navy-200", teal: "bg-teal-50 text-teal-700 ring-teal-100", gray: "bg-slate-100 text-slate-700 ring-slate-200",
};
export function Badge({ tone = "gray", children, className }: { tone?: keyof typeof TONES | string; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset", TONES[tone] ?? TONES.gray, className)}>{children}</span>;
}
const STATUS_TONE: Record<string, string> = {
  draft: "gray", published: "blue", quotation_open: "teal", qualification: "amber", scheduled: "blue", live: "green", closed: "gray", cancelled: "red", awarded: "green",
  approved: "green", pending: "amber", rejected: "red", suspended: "red", qualified: "green", disqualified: "red", submitted: "teal", withdrawn: "gray",
  sent: "blue", delivered: "green", failed: "red", skipped: "gray", processing: "amber", invited: "blue", viewed: "teal", declined: "red",
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "gray"}>
      {status === "live" && <span className="live-dot h-2 w-2 rounded-full bg-emerald-500" />}
      {STATUS_LABEL[status] ?? status.replace(/_/g, " ")}
    </Badge>
  );
}
export const DemoBadge = () => <Badge tone="amber" className="ml-1.5">DEMO</Badge>;

export function Alert({ tone = "red", children }: { tone?: "red" | "amber" | "green" | "blue"; children: ReactNode }) {
  const t = { red: "border-red-200 bg-red-50 text-red-800", amber: "border-amber-200 bg-amber-50 text-amber-900", green: "border-emerald-200 bg-emerald-50 text-emerald-900", blue: "border-navy-200 bg-navy-50 text-navy-800" }[tone];
  return <div role={tone === "red" ? "alert" : "status"} className={cx("rounded-lg border px-4 py-3 text-sm", t)}>{children}</div>;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("overflow-x-auto", className)}><table className="w-full min-w-max text-left text-sm">{children}</table></div>;
}
export const Th = ({ children, className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th {...p} className={cx("whitespace-nowrap border-b border-navy-100 bg-navy-50/60 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy-600", className)}>{children}</th>;
export const Td = ({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cx("border-b border-navy-50 px-3 py-2.5 align-top", className)}>{children}</td>;

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-navy-200 bg-navy-50/40 px-4 py-8 text-center text-sm text-navy-500">{children}</p>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <h3 className="mb-3 text-base font-semibold text-navy-900">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Asks for a mandatory reason, then runs `onConfirm(reason)`. */
export function ReasonDialog({ open, onClose, title, label = "Reason", confirmLabel = "Confirm", danger, onConfirm, children }: {
  open: boolean; onClose: () => void; title: string; label?: string; confirmLabel?: string; danger?: boolean; onConfirm: (reason: string) => Promise<void>; children?: ReactNode;
}) {
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { if (open) { setReason(""); setErr(""); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {children}
      <Field label={label} error={err}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={async () => {
          setBusy(true); setErr("");
          try { await onConfirm(reason); onClose(); } catch (e: any) { setErr(e.fields?.reason ?? e.message); } finally { setBusy(false); }
        }}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "teal" | "navy" | "amber" }) {
  const c = tone === "amber" ? "text-amber-700" : tone === "navy" ? "text-navy-800" : "text-teal-700";
  return (
    <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-navy-500">{label}</div>
      <div className={cx("mt-1 text-3xl font-bold tabular", c)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-navy-500">{sub}</div>}
    </div>
  );
}

export function KV({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs font-medium uppercase tracking-wide text-navy-500">{label}</dt><dd className="mt-0.5 text-sm text-navy-900">{children || "—"}</dd></div>;
}
