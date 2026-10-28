import { DateTime } from "luxon";
import { TZ } from "./format";

/** Interprets a `datetime-local` string ("2026-11-02T15:30") as wall-clock time in the app timezone and returns the UTC instant. */
export function parseLocalInput(s: string): Date {
  const d = DateTime.fromISO(s, { zone: TZ });
  if (!d.isValid) throw new Error("Invalid date/time");
  return d.toJSDate();
}
