import { DomainError, q, q1, translateDbError, withAuth, withUser } from "../db";
import { hashPassword } from "../auth/password";
import { revokeAllSessions, type SessionUser } from "../auth/session";
import type { z } from "zod";
import type { registerVendorSchema, staffUserSchema, vendorProfileSchema } from "../validation";

export async function registerVendor(i: z.infer<typeof registerVendorSchema>) {
  const hash = await hashPassword(i.password);
  try {
    return await withAuth(async (db) => {
      const r = await q1<{ id: string }>(db, "select register_vendor($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) as id",
        [i.email, i.contactName, i.phone || null, hash, i.legalName, i.gstin || null, i.pan || null, i.contactName, i.email, i.phone || null,
         i.whatsapp || null, i.address || null, i.city || null, i.state || null, i.country || null]);
      return r!.id;
    });
  } catch (e: any) {
    if (e?.code === "23505") {
      if (String(e.constraint).includes("profiles_email")) throw new DomainError("EMAIL_TAKEN", "An account with this e-mail already exists.", 409, { fields: { email: "Already registered" } });
      if (String(e.constraint).includes("gstin")) throw new DomainError("GSTIN_TAKEN", "This GSTIN is already registered. Contact Grainspan procurement.", 409, { fields: { gstin: "Already registered" } });
    }
    translateDbError(e);
  }
}

export async function listVendors(userId: string, opts: { status?: string; search?: string } = {}) {
  return withUser(userId, (db) => q<any>(db,
    `select v.id, v.vendor_code, v.legal_name, v.gstin, v.contact_name, v.contact_email, v.contact_phone, v.whatsapp_number, v.city, v.state, v.status, v.status_reason,
            v.is_demo, v.created_at, v.approved_at,
            (select count(*) from rfq_invitations i where i.vendor_id = v.id)::int as invitations,
            (select count(*) from vendor_offers o where o.vendor_id = v.id and o.status = 'submitted')::int as quotations
       from vendors v
      where ($1::text is null or v.status::text = $1)
        and ($2::text is null or v.legal_name ilike '%'||$2||'%' or v.vendor_code ilike '%'||$2||'%' or v.contact_email ilike '%'||$2||'%' or v.gstin ilike '%'||$2||'%')
      order by (v.status = 'pending') desc, v.legal_name limit 500`, [opts.status || null, opts.search || null]));
}

export async function setVendorStatus(user: SessionUser, vendorId: string, status: string, reason?: string | null) {
  try {
    return await withUser(user.id, async (db) => {
      if (["rejected", "suspended"].includes(status) && !reason?.trim()) throw new DomainError("VALIDATION", "Please record a reason.", 400, { fields: { reason: "Required" } });
      const r = await db.query("update vendors set status=$2, status_reason=$3 where id=$1", [vendorId, status, reason?.trim() || null]);
      if (!r.rowCount) throw new DomainError("NOT_FOUND", "Vendor not found.", 404);
    });
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function updateOwnProfile(user: SessionUser, i: z.infer<typeof vendorProfileSchema>) {
  try {
    await withUser(user.id, async (db) => {
      await db.query(
        `update vendors set contact_name=$2, contact_email=lower($3), contact_phone=$4, whatsapp_number=$5, address=$6, email_notifications=$7, whatsapp_notifications=$8 where id=$1`,
        [user.vendorId, i.contactName, i.contactEmail, i.contactPhone || null, i.whatsapp || null, i.address || null, i.emailNotifications, i.whatsappNotifications]);
    });
  } catch (e) { translateDbError(e); }
}

// ------------------------------------------------------------------ staff accounts (administrator only)
export async function listStaff(userId: string) {
  return withUser(userId, (db) => q<any>(db, "select id, email, full_name, phone, role, is_active, last_login_at, created_at from profiles where role in ('admin','procurement_manager','approver') order by full_name"));
}

export async function createStaff(user: SessionUser, i: z.infer<typeof staffUserSchema>) {
  const hash = await hashPassword(i.password);
  try {
    return await withUser(user.id, async (db) => (await q1<{ id: string }>(db, "select admin_create_user($1,$2,$3,$4,$5,true) as id", [i.email, i.fullName, i.phone || null, i.role, hash]))!.id);
  } catch (e: any) {
    if (e?.code === "23505") throw new DomainError("EMAIL_TAKEN", "An account with this e-mail already exists.", 409);
    translateDbError(e);
  }
}

export async function setUserActive(admin: SessionUser, userId: string, active: boolean) {
  if (userId === admin.id) throw new DomainError("FORBIDDEN", "You cannot deactivate your own account.", 400);
  try {
    await withUser(admin.id, async (db) => {
      const r = await db.query("update profiles set is_active=$2 where id=$1", [userId, active]);
      if (!r.rowCount) throw new DomainError("NOT_FOUND", "User not found.", 404);
    });
    if (!active) await revokeAllSessions(userId);
  } catch (e) { if (e instanceof DomainError) throw e; translateDbError(e); }
}

export async function adminResetPassword(admin: SessionUser, userId: string, newPassword: string) {
  const hash = await hashPassword(newPassword);
  await withUser(admin.id, async (db) => {
    const t = await q1<any>(db, "select id from profiles where id=$1 and role <> 'system'", [userId]);       // admin can see the profile → authorised
    if (!t) throw new DomainError("NOT_FOUND", "User not found.", 404);
    await db.query("select write_audit('user.password_reset','user',$1,null,null,'Password reset by administrator',null,null,null,null)", [userId]);
  });
  await withAuth((db) => db.query("update user_credentials set password_hash=$2, must_change_password=true, failed_login_count=0, locked_until=null, password_changed_at=now() where user_id=$1", [userId, hash]));
  await revokeAllSessions(userId);
}
