import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Logo } from "@/components/brand";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const u = await getCurrentUser();
  if (u) redirect("/");
  const sp = await searchParams;
  return (
    <main className="grid min-h-[calc(100vh-30px)] lg:grid-cols-2">
      <section className="hidden bg-gradient-to-br from-navy-900 via-navy-800 to-teal-700 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Logo light />
        <div>
          <h1 className="text-3xl font-bold leading-tight">Live procurement &amp;<br />reverse auctions</h1>
          <p className="mt-3 max-w-md text-navy-100">Competitive, auditable sourcing for Grainspan Nutrients Private Limited — RFQs, qualified quotations, live FOR bidding and controlled award allocation in one secure portal.</p>
        </div>
        <p className="text-xs text-navy-200">Authorised users only. Activity is logged.</p>
      </section>
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h2 className="text-2xl font-bold text-navy-900">Sign in</h2>
          <p className="mb-6 mt-1 text-sm text-navy-500">Grainspan staff and registered suppliers.</p>
          <LoginForm expired={sp.expired === "1"} />
        </div>
      </section>
    </main>
  );
}
