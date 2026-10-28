import Link from "next/link";
import { Logo } from "@/components/brand";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Supplier registration" };
export default function RegisterPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/login"><Logo /></Link>
      <h1 className="mt-6 text-2xl font-bold text-navy-900">Supplier registration</h1>
      <p className="mb-6 mt-1 text-sm text-navy-500">Register your company to be considered for Grainspan RFQs. Grainspan procurement verifies every registration before a supplier can be invited.</p>
      <RegisterForm />
    </main>
  );
}
