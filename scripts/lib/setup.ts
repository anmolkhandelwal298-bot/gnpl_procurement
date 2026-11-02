/* Shared, idempotent setup routines used by the CLI scripts AND by scripts/boot.ts (one-click hosting). */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { hashPassword, passwordProblem } from "../../src/lib/auth/password";

export function ownerClient(url: string): Client {
  const ssl = process.env.DATABASE_SSL;
  return new Client({ connectionString: url, ssl: ssl && ssl !== "false" ? { rejectUnauthorized: ssl !== "no-verify" } : undefined });
}

/** Applies db/migrations/*.sql in order (each in a transaction, tracked in schema_migrations). Returns the names applied. */
export async function runMigrations(c: Client, opts: { reset?: boolean; log?: (m: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  if (opts.reset) {
    if (process.env.NODE_ENV === "production") throw new Error("--reset is refused in production");
    await c.query("drop schema public cascade; create schema public;");
    log("schema reset");
  }
  await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await c.query("select name from schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    try {
      await c.query("begin");
      await c.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await c.query("insert into schema_migrations(name) values ($1)", [f]);
      await c.query("commit");
      applied.push(f); log(`applied ${f}`);
    } catch (e) {
      await c.query("rollback");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return applied;
}

export async function setAppRolePassword(c: Client, password: string) {
  await c.query(`alter role grainspan_app with login password ${c.escapeLiteral(password)}`);
}

/** Creates the administrator (must change password at first sign-in). With ifMissing, does nothing when any admin already exists. */
export async function createAdmin(c: Client, a: { email: string; name: string; password: string; ifMissing?: boolean }): Promise<"created" | "updated" | "skipped"> {
  const problem = passwordProblem(a.password);
  if (problem) throw new Error(`admin password rejected: ${problem}`);
  if (a.ifMissing && (await c.query("select 1 from profiles where role='admin' limit 1")).rowCount) return "skipped";
  const hash = await hashPassword(a.password);
  try {
    await c.query("begin");
    await c.query("select set_config('app.mode','system',true), set_config('app.user_id','00000000-0000-0000-0000-000000000001',true)");
    const existed = (await c.query("select 1 from profiles where lower(email)=lower($1)", [a.email.trim()])).rowCount! > 0;
    const p = await c.query(
      `insert into profiles(email, full_name, role) values ($1,$2,'admin')
       on conflict (lower(email)) do update set full_name = excluded.full_name, role = 'admin', is_active = true returning id`, [a.email.trim(), a.name.trim()]);
    await c.query(
      `insert into user_credentials(user_id, password_hash, must_change_password) values ($1,$2,true)
       on conflict (user_id) do update set password_hash = excluded.password_hash, must_change_password = true, failed_login_count = 0, locked_until = null, password_changed_at = now()`,
      [p.rows[0].id, hash]);
    await c.query("commit");
    return existed ? "updated" : "created";
  } catch (e) { await c.query("rollback"); throw e; }
}

export { DEMO_ACCOUNTS } from "../../src/lib/demo-accounts";

/** DEMO staff, vendors and one DEMO RFQ in the quotation phase with NO bids. Everything is flagged is_demo. Idempotent. */
export async function seedDemo(c: Client, PASSWORD: string): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await c.query("begin");
  try {
    await c.query("select set_config('app.mode','system',true), set_config('app.user_id','00000000-0000-0000-0000-000000000001',true)");
    const mkStaff = async (email: string, name: string, role: string) => {
      const r = await c.query(
        `insert into profiles(email, full_name, role) values ($1,$2,$3) on conflict (lower(email)) do update set full_name = excluded.full_name returning id`, [email, name, role]);
      await c.query(
        `insert into user_credentials(user_id, password_hash, must_change_password) values ($1,$2,false) on conflict (user_id) do update set password_hash = excluded.password_hash`, [r.rows[0].id, hash]);
      return r.rows[0].id as string;
    };
    const admin = await mkStaff("admin@grainspan.demo", "Asha Menon (Admin)", "admin");
    const manager = await mkStaff("manager@grainspan.demo", "Rohit Verma (Procurement Manager)", "procurement_manager");
    await mkStaff("approver@grainspan.demo", "Neha Kapoor (Approver)", "approver");

    const vendors = [
      ["Kalinga Coal & Logistics Pvt Ltd", "kalinga", "24AABCK1234F1Z5", "Bhubaneswar", "Odisha"],
      ["Sagar Fuels International", "sagar", "24AAECS5678Q1Z2", "Mundra", "Gujarat"],
      ["Bharat Energy Resources Ltd", "bharat", "27AAACB9012L1Z8", "Mumbai", "Maharashtra"],
      ["Coastal Minerals Trading Co", "coastal", "33AAFCC3456M1Z1", "Chennai", "Tamil Nadu"],
    ];
    const vendorIds: string[] = [];
    for (const [name, slug, gstin, city, state] of vendors) {
      const email = `${slug}@vendor.demo`;
      const p = await c.query(`insert into profiles(email, full_name, role) values ($1,$2,'vendor') on conflict (lower(email)) do update set full_name=excluded.full_name returning id`, [email, `${name} (demo user)`]);
      await c.query(`insert into user_credentials(user_id, password_hash, must_change_password) values ($1,$2,false) on conflict (user_id) do update set password_hash=excluded.password_hash`, [p.rows[0].id, hash]);
      let v = await c.query("select vu.vendor_id from vendor_users vu where vu.user_id=$1", [p.rows[0].id]);
      if (!v.rowCount) {
        const ins = await c.query(
          `insert into vendors(legal_name, gstin, contact_name, contact_email, contact_phone, city, state, status, approved_by, approved_at, is_demo, whatsapp_number)
           values ($1,$2,$3,$4,'+91 98000 00000',$5,$6,'approved',$7,now(),true,$8) returning id`,
          [name, gstin, `${name.split(" ")[0]} Sales Desk`, email, city, state, admin, "+9198000000" + String(vendorIds.length).padStart(2, "0")]);
        await c.query("insert into vendor_users(user_id, vendor_id, is_primary) values ($1,$2,true)", [p.rows[0].id, ins.rows[0].id]);
        v = { rows: [{ vendor_id: ins.rows[0].id }] } as any;
      }
      vendorIds.push(v.rows[0].vendor_id);
    }
    // one pending registration so the approval queue is not empty
    const pend = await c.query(`insert into profiles(email, full_name, role) values ('pending@vendor.demo','Pending Vendor (demo user)','vendor') on conflict (lower(email)) do nothing returning id`);
    if (pend.rowCount) {
      await c.query("insert into user_credentials(user_id, password_hash) values ($1,$2)", [pend.rows[0].id, hash]);
      const pv = await c.query(`insert into vendors(legal_name, contact_name, contact_email, status, is_demo, city, state) values ('Himalaya Carbon Traders (awaiting approval)','Pending Desk','pending@vendor.demo','pending',true,'Dehradun','Uttarakhand') returning id`);
      await c.query("insert into vendor_users(user_id, vendor_id, is_primary) values ($1,$2,true)", [pend.rows[0].id, pv.rows[0].id]);
    }

    const exists = await c.query("select 1 from rfqs where is_demo limit 1");
    if (!exists.rowCount) {
      const rfq = await c.query(
        `insert into rfqs(material_name, grade, required_qty_mt, min_gcv_arb, max_moisture_pct, max_ash_pct, origin, other_specs, delivery_location, delivery_basis,
           delivery_schedule, payment_terms, quotation_deadline, auction_start_at, auction_end_at, min_decrement, ext_enabled, ext_trigger_seconds, ext_duration_seconds, ext_max_count,
           coa_required, doc_requirements, additional_terms, compliance_mode, created_by, is_demo)
         values ('Imported Steam Coal','GCV 4200 (ARB)',1000,4200,18,12,'Indonesia / South Africa','Sulphur < 0.8% (ARB), size 0-50 mm, HGI > 45',
           'Grainspan Nutrients plant, Kutch, Gujarat','FOR','Four rakes within 30 days of PO, 250 MT per rake',
           '95% against delivery documents, 5% within 15 days of unloading',
           now() + interval '3 days', now() + interval '4 days', now() + interval '4 days 1 hour', 25, true, 120, 120, 5,
           true,'Independent surveyor COA (SGS / Intertek / equivalent) dated within 30 days','Prices in INR per metric tonne, FOR plant. GST extra as applicable.','strict',$1,true) returning id`, [manager]);
      for (const v of vendorIds) await c.query("insert into rfq_invitations(rfq_id, vendor_id, invited_by) values ($1,$2,$3)", [rfq.rows[0].id, v, manager]);
      await c.query("update rfqs set status='published' where id=$1", [rfq.rows[0].id]);
      await c.query("update rfqs set status='quotation_open' where id=$1", [rfq.rows[0].id]);
      console.log("demo RFQ created (quotation open, no quotations or bids)");
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}
