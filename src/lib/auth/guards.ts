import { redirect } from "next/navigation";
import { getCurrentUser, type SessionUser } from "./session";
import type { Role } from "../db";

export async function requireUser(): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return u;
}
export async function requireRole(roles: Role[]): Promise<SessionUser> {
  const u = await requireUser();
  if (u.mustChangePassword) redirect("/account/password");
  if (!roles.includes(u.role)) redirect(u.role === "vendor" ? "/vendor" : "/admin");
  return u;
}
export const requireStaff = () => requireRole(["admin", "procurement_manager", "approver"]);
export const requireVendor = () => requireRole(["vendor"]);
export const ROLE_LABEL: Record<string, string> = { admin: "Administrator", procurement_manager: "Procurement manager", approver: "Approver", vendor: "Vendor" };
