import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

type EncryptedSecret = { ciphertext: string; nonce: string; tag: string; fingerprint: string };

function encryptionKey(): Buffer {
  const value = process.env.CUSTOM_TOOL_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("Custom tool encryption is not configured.");
  const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("CUSTOM_TOOL_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return decoded;
}

export function encryptCustomToolSecret(value: string): EncryptedSecret {
  const key = encryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    fingerprint: createHmac("sha256", key).update(value).digest("hex").slice(0, 12),
  };
}

export function decryptCustomToolSecret(value: Pick<EncryptedSecret, "ciphertext" | "nonce" | "tag">): string {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(value.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function customToolSourceDigest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
