import "server-only";

import { createHmac } from "node:crypto";

function hashKey(): Buffer {
  const value = process.env.USER_MEMORY_HASH_KEY?.trim();
  if (!value) throw new Error("User memory hashing is not configured.");
  const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("USER_MEMORY_HASH_KEY must encode exactly 32 bytes.");
  return decoded;
}

export function hashSensitiveMemory(value: string): string {
  return createHmac("sha256", hashKey()).update(value, "utf8").digest("hex");
}
