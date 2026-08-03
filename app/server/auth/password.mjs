import { promisify } from "node:util";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const scrypt = promisify(nodeScrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const MAX_MEMORY = 32 * 1024 * 1024;

function parameters(n, r, p) {
  if (!Number.isInteger(n) || n < 16_384 || n > 1_048_576 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 8 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 4) return null;
  if (128 * n * r > MAX_MEMORY) return null;
  return { N: n, r, p, maxmem: MAX_MEMORY };
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0) throw new Error("A password is required.");
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, parameters(DEFAULT_N, DEFAULT_R, DEFAULT_P));
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const options = parameters(n, r, p);
  if (!options) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = Buffer.from(await scrypt(password, salt, KEY_LENGTH, options));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
