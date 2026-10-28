import Link from "next/link";
import { requireStaff, ROLE_LABEL } from "@/lib/auth/guards";
import { Logo } from "@/components/brand";
import { LogoutButton } from "@/components/logout-button";
import { AdminNav } from "./nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireStaff();
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[230px_1fr]">
      <aside className="bg-navy-900 text-white lg:sticky lg:top-0 lg:h-screen">
        <div className="flex items-center justify-between px-5 py-4 lg:block"><Link href="/admin"><Logo light /></Link></div>
        <AdminNav isAdmin={user.role === "admin"} />
        <div className="hidden border-t border-white/10 p-4 text-xs text-navy-200 lg:absolute lg:bottom-0 lg:block lg:w-[230px]">
          <div className="font-semibold text-white">{user.fullName}</div>
          <div>{ROLE_LABEL[user.role]}</div>
          <div className="mt-2 flex gap-1"><Link href="/account/password" className="rounded px-2 py-1 hover:bg-white/10">Password</Link><LogoutButton className="rounded px-2 py-1 hover:bg-white/10" /></div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-between border-b border-navy-100 bg-white px-5 py-2.5 lg:hidden">
          <span className="text-sm font-medium text-navy-700">{user.fullName} · {ROLE_LABEL[user.role]}</span><LogoutButton className="text-sm font-medium text-teal-700" />
        </header>
        <main className="mx-auto max-w-[1400px] p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
