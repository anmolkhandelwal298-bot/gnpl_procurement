"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [["", "Overview"], ["/quotations", "Quotations"], ["/auction", "Live auction"], ["/comparison", "Comparison"], ["/allocation", "Allocation & award"], ["/audit", "Audit trail"]];
export function RfqTabs({ id }: { id: string }) {
  const p = usePathname();
  const base = `/admin/rfqs/${id}`;
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-navy-100">
      {TABS.map(([suffix, label]) => {
        const href = base + suffix; const on = suffix === "" ? p === base || p === base + "/edit" : p.startsWith(href);
        return <Link key={href} href={href} className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold ${on ? "border-teal-600 text-teal-700" : "border-transparent text-navy-500 hover:text-navy-800"}`}>{label}</Link>;
      })}
    </nav>
  );
}
