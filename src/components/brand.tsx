export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#0f9b9e" />
        <path d="M16 6c-2.6 3-3.6 5.4-3.6 8 0 1.7.6 3 1.6 4M16 6c2.6 3 3.6 5.4 3.6 8 0 1.7-.6 3-1.6 4M16 26V12M9 14c2 .4 3.4 1.4 4.2 3M23 14c-2 .4-3.4 1.4-4.2 3M10 20c1.6.2 2.8.9 3.6 2M22 20c-1.6.2-2.8.9-3.6 2" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </svg>
      <span className={`leading-tight ${light ? "text-white" : "text-navy-900"}`}>
        <span className="block text-sm font-bold tracking-wide">GRAINSPAN</span>
        <span className={`block text-[10px] font-medium uppercase tracking-[0.18em] ${light ? "text-teal-100" : "text-teal-700"}`}>Procurement Portal</span>
      </span>
    </span>
  );
}
