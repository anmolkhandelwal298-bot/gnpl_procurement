import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/guards";
import { listStaff } from "@/lib/services/vendors";
import { UsersView } from "./view";

export const metadata = { title: "Staff users" };
export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await requireStaff();
  if (user.role !== "admin") redirect("/admin");
  return <UsersView users={JSON.parse(JSON.stringify(await listStaff(user.id)))} me={user.id} />;
}
