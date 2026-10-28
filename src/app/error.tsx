"use client";
import { Logo } from "@/components/brand";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-4 py-24 text-center">
      <div className="mb-8 flex justify-center"><Logo /></div>
      <h1 className="text-2xl font-bold text-navy-800">Something went wrong</h1>
      <p className="mt-3 text-sm text-navy-600">The request could not be completed. Please try again; if the problem continues contact Grainspan procurement and quote the reference below.</p>
      {error.digest && <p className="mt-2 font-mono text-xs text-navy-400">Ref: {error.digest}</p>}
      <button onClick={reset} className="mt-6 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700">Try again</button>
    </main>
  );
}
