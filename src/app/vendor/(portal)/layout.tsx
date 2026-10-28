import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { Logo } from "@/components/brand";
import { LogoutButton } from "@/components/logout-button";

export default async function VendorLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  // /vendor/register is public and has its own page; everything else under /vendor needs a vendor session.
  if (u.mustChangePassword) redirect("/account/password");
  if (u.role !== "vendor") redirect("/admin");
  return (
    <div className="min-h-screen">
      <header className="bg-navy-900 text-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/vendor"><Logo light /></Link>
          <nav className="flex items-center gap-0.5 whitespace-nowrap text-sm">
            <Link href="/vendor" className="rounded-lg px-2.5 py-1.5 font-medium hover:bg-white/10">My RFQs</Link>
            <Link href="/vendor/profile" className="rounded-lg px-2.5 py-1.5 font-medium hover:bg-white/10">Profile</Link>
            <LogoutButton />
          </nav>
        </div>
        <div className="border-t border-white/10 bg-navy-800 px-4 py-1.5 text-xs text-navy-200"><div className="mx-auto max-w-5xl">{u.vendorName} · {u.email}</div></div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  );
}
