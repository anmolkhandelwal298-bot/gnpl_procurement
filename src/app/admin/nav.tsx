"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/admin", label: "Overview", exact: true }, { href: "/admin/rfqs", label: "RFQs" }, { href: "/admin/vendors", label: "Vendors" },
  { href: "/admin/audit", label: "Audit & reports" }, { href: "/admin/notifications", label: "Notifications" },
];
export function AdminNav({ isAdmin }: { isAdmin: boolean }) {
  const p = usePathname();
  const items = isAdmin ? [...ITEMS, { href: "/admin/users", label: "Staff users" }] : ITEMS;
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:px-3">
      {items.map((i) => {
        const on = i.exact ? p === i.href : p.startsWith(i.href);
        return <Link key={i.href} href={i.href} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${on ? "bg-teal-600 text-white" : "text-navy-100 hover:bg-white/10"}`}>{i.label}</Link>;
      })}
    </nav>
  );
}
