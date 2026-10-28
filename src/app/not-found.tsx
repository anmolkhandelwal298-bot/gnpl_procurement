import Link from "next/link";
import { Logo } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-24 text-center">
      <div className="mb-8 flex justify-center"><Logo /></div>
      <h1 className="text-5xl font-extrabold text-navy-800">404</h1>
      <p className="mt-3 text-navy-600">This page does not exist, or you do not have access to it.</p>
      <Link href="/" className="mt-6 inline-block rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700">Back to the portal</Link>
    </main>
  );
}
