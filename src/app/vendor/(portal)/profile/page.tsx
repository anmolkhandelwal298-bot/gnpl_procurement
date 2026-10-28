import { requireVendor } from "@/lib/auth/guards";
import { q1, withUser } from "@/lib/db";
import { ProfileForm } from "./form";

export const metadata = { title: "Profile" };
export const dynamic = "force-dynamic";
export default async function ProfilePage() {
  const user = await requireVendor();
  const v = await withUser(user.id, (db) => q1<any>(db, "select vendor_code, legal_name, gstin, pan, contact_name, contact_email, contact_phone, whatsapp_number, address, status, email_notifications, whatsapp_notifications from vendors"));
  return <ProfileForm v={JSON.parse(JSON.stringify(v))} />;
}
