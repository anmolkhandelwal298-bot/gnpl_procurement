"use client";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public fields: Record<string, string> = {}, public details?: unknown) { super(message); }
}

export async function apiFetch<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: opts.form ? undefined : opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: "same-origin",
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) window.location.href = "/login?expired=1";
    const e = data?.error ?? {};
    throw new ApiError(e.code ?? "ERROR", e.message ?? `Request failed (${res.status})`, res.status, e.fields ?? e.details?.fields ?? {}, e.details);
  }
  return data as T;
}
