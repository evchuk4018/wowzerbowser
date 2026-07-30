import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("Connector credential encryption is not configured.");
  const value = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (value.length !== 32) throw new Error("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY must contain 32 bytes.");
  return value;
}

export function encryptConnectorCredentials(value: Record<string, unknown>) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authTag: authTag.toString("base64url"),
    fingerprint: createHash("sha256").update(ciphertext).digest("hex").slice(0, 16),
  };
}

export function decryptConnectorCredentials(row: { credentials_ciphertext?: string | null; credentials_nonce?: string | null; credentials_auth_tag?: string | null }): Record<string, unknown> {
  if (!row.credentials_ciphertext || !row.credentials_nonce || !row.credentials_auth_tag) return {};
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.credentials_nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(row.credentials_auth_tag, "base64url"));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(row.credentials_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const value = JSON.parse(clear) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connector credentials are invalid.");
  return value as Record<string, unknown>;
}
