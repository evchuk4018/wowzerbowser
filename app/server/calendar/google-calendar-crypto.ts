import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedCalendarToken = { ciphertext: string; nonce: string; authTag: string };

function tokenKey(): Buffer {
  const value = process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("Google Calendar token encryption is not configured.");
  const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return decoded;
}

export function encryptCalendarToken(token: string): EncryptedCalendarToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCalendarToken(token: EncryptedCalendarToken): string {
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(token.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(token.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(token.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
