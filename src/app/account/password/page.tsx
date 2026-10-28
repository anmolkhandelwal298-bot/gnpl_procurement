import { requireUser } from "@/lib/auth/guards";
import { Logo } from "@/components/brand";
import { ChangePasswordForm } from "./form";

export const metadata = { title: "Change password" };
export default async function Page() {
  const u = await requireUser();
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <Logo />
      <h1 className="mb-1 mt-6 text-2xl font-bold text-navy-900">Change password</h1>
      <p className="mb-4 text-sm text-navy-500">{u.mustChangePassword ? "You must set a new password before continuing." : `Signed in as ${u.email}`}</p>
      <ChangePasswordForm />
    </main>
  );
}
