import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedConnectorValue = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  fingerprint: string;
};

function key(): Buffer {
  const raw = process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("Connector credential encryption is not configured.");
  const value = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (value.length !== 32) throw new Error("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY must contain 32 bytes.");
  return value;
}

function encryptRecord(value: Record<string, unknown>): EncryptedConnectorValue {
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

function decryptRecord(
  row: { ciphertext?: string | null; nonce?: string | null; authTag?: string | null },
): Record<string, unknown> {
  if (!row.ciphertext || !row.nonce || !row.authTag) return {};
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(row.authTag, "base64url"));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const value = JSON.parse(clear) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connector credentials are invalid.");
  return value as Record<string, unknown>;
}

export function encryptConnectorCredentials(value: Record<string, unknown>): EncryptedConnectorValue {
  return encryptRecord(value);
}

export function decryptConnectorCredentials(row: {
  credentials_ciphertext?: string | null;
  credentials_nonce?: string | null;
  credentials_auth_tag?: string | null;
}): Record<string, unknown> {
  return decryptRecord({
    ciphertext: row.credentials_ciphertext,
    nonce: row.credentials_nonce,
    authTag: row.credentials_auth_tag,
  });
}

export function encryptConnectorMetadata(value: Record<string, unknown>): EncryptedConnectorValue {
  return encryptRecord(value);
}

export function decryptConnectorMetadata(row: {
  metadata_ciphertext?: string | null;
  metadata_nonce?: string | null;
  metadata_auth_tag?: string | null;
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  if (row.metadata_ciphertext && row.metadata_nonce && row.metadata_auth_tag) {
    return decryptRecord({
      ciphertext: row.metadata_ciphertext,
      nonce: row.metadata_nonce,
      authTag: row.metadata_auth_tag,
    });
  }
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
}
