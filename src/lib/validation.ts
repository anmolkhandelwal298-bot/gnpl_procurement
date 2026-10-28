import { z } from "zod";

const money = (label: string) =>
  z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(
    z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, `${label} must be a positive amount with at most 2 decimals`)).refine((v) => Number(v) > 0, `${label} must be greater than zero`);
const qty = (label: string) =>
  z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(
    z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, `${label} must be a number with at most 3 decimals`)).refine((v) => Number(v) > 0, `${label} must be greater than zero`);
const optText = (max = 2000) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Use the date/time picker");
/** "" / missing -> null; otherwise validate with `inner`. Keeps the key optional in the input. */
const blankToNull = (v: unknown) => (v === "" || v === undefined ? null : v);
const nullable = <T extends z.ZodType>(inner: T) => z.preprocess(blankToNull, inner.nullable()).optional().transform((v) => (v ?? null) as z.output<T> | null);
const pctNum = (label: string) => z.coerce.number({ error: `${label} is required` }).min(0, `${label} cannot be negative`).max(100, `${label} cannot exceed 100`);

export const loginSchema = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });

export const passwordSchema = z.string().min(10, "At least 10 characters").max(128).refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "Must contain a letter and a number");

export const registerVendorSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN").optional().or(z.literal("")),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Enter a valid PAN").optional().or(z.literal("")),
  contactName: z.string().trim().min(2).max(120),
  email: z.email("Enter a valid e-mail address").max(200),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  whatsapp: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, "Use international format, e.g. +919876543210").optional().or(z.literal("")),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  state: z.string().trim().max(100).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
  password: passwordSchema,
});

export const rfqSchema = z.object({
  materialName: z.string().trim().min(2, "Material name is required").max(120),
  grade: optText(60),
  requiredQtyMt: qty("Required quantity"),
  minGcvArb: z.coerce.number({ error: "Minimum GCV is required" }).int().min(1000, "Enter GCV in kcal/kg").max(10000),
  maxMoisturePct: pctNum("Maximum moisture"),
  maxAshPct: nullable(pctNum("Maximum ash")),
  origin: optText(200),
  otherSpecs: optText(4000),
  deliveryLocation: z.string().trim().min(2, "Delivery location is required").max(300),
  deliveryBasis: z.string().trim().min(2).max(60).default("FOR"),
  deliverySchedule: optText(1000),
  paymentTerms: optText(1000),
  quotationOpenAt: localDateTime.optional().or(z.literal("")).transform((v) => v || null),
  quotationDeadline: localDateTime.optional().or(z.literal("")).transform((v) => v || null),
  auctionStartAt: localDateTime.optional().or(z.literal("")).transform((v) => v || null),
  auctionEndAt: localDateTime.optional().or(z.literal("")).transform((v) => v || null),
  minDecrement: money("Minimum bid decrement"),
  extEnabled: z.coerce.boolean().default(false),
  extTriggerSeconds: z.coerce.number().int().min(5).max(3600).default(120),
  extDurationSeconds: z.coerce.number().int().min(5).max(3600).default(120),
  extMaxCount: z.coerce.number().int().min(0).max(50).default(5),
  coaRequired: z.coerce.boolean().default(true),
  docRequirements: optText(2000),
  additionalTerms: optText(4000),
  complianceMode: z.enum(["strict", "review"]).default("strict"),
  invitedVendorIds: z.array(z.uuid()).max(200).default([]),
});
export type RfqInput = z.infer<typeof rfqSchema>;

export const offerSchema = z.object({
  origin: optText(200),
  gcvArb: nullable(z.coerce.number().int().min(1000, "Enter GCV in kcal/kg").max(10000)),
  moisturePct: nullable(pctNum("Moisture")),
  ashPct: nullable(pctNum("Ash")),
  otherParams: z.record(z.string().max(60), z.string().max(200)).default({}),
  qtyOfferedMt: nullable(qty("Quantity offered")),
  initialForPrice: nullable(money("Initial FOR price")),
  leadTimeDays: nullable(z.coerce.number().int().min(0).max(365)),
  remarks: optText(2000),
  submit: z.boolean().default(false),
});
export type OfferInput = z.infer<typeof offerSchema>;

export const bidSchema = z.object({
  amount: money("Bid"),
  idempotencyKey: z.string().min(8).max(100),
});

export const scheduleAuctionSchema = z.object({
  startAt: localDateTime, endAt: localDateTime,
});
export const reasonSchema = z.object({ reason: z.string().trim().min(5, "Please give a reason (at least 5 characters)").max(1000) });
export const extendSchema = z.object({ minutes: z.coerce.number().int().min(1).max(240), reason: z.string().trim().min(5).max(1000) });

export const qualifySchema = z.object({
  status: z.enum(["pending", "qualified", "disqualified"]),
  remarks: z.string().trim().max(1000).optional().nullable(),
});

export const allocationSchema = z.object({
  lines: z.array(z.object({
    vendorId: z.uuid(),
    qty: z.union([z.string(), z.number()]).transform((v) => String(v).trim() || "0").pipe(z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Quantity must be a non-negative number with at most 3 decimals")),
    remarks: z.string().trim().max(1000).optional().nullable(),
  })).max(200),
});
export const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]), remarks: z.string().trim().max(1000).optional().nullable() });
export const submitAwardSchema = z.object({ remarks: z.string().trim().max(1000).optional().nullable() });

export const vendorStatusSchema = z.object({ status: z.enum(["approved", "rejected", "suspended", "pending"]), reason: z.string().trim().max(1000).optional().nullable() });
export const vendorProfileSchema = z.object({
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.email().max(200),
  contactPhone: z.string().trim().max(30).optional().or(z.literal("")),
  whatsapp: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, "Use international format, e.g. +919876543210").optional().or(z.literal("")),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  emailNotifications: z.boolean(),
  whatsappNotifications: z.boolean(),
});
export const staffUserSchema = z.object({
  email: z.email().max(200), fullName: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).optional().or(z.literal("")),
  role: z.enum(["admin", "procurement_manager", "approver"]), password: passwordSchema,
});
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });
export const inviteSchema = z.object({ vendorIds: z.array(z.uuid()).min(1).max(200) });
