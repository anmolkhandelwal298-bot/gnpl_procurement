import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";

export default async function Home() {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.mustChangePassword) redirect("/account/password");
  redirect(u.role === "vendor" ? "/vendor" : "/admin");
}
