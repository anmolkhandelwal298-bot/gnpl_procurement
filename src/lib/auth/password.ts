import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 32768, R = 8, P = 1, KEYLEN = 32;
const opts: ScryptOptions = { N, r: R, p: P, maxmem: 128 * N * R * 2 };

const scryptAsync = (pw: string, salt: Buffer, keylen: number, o: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, keylen, o, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, opts);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A real hash of a random password: verified against when the account doesn't exist so response time doesn't reveal it.
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString("hex")));

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 128) return "Password must be at most 128 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain at least one letter and one number.";
  return null;
}
