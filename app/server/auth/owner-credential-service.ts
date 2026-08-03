import "server-only";

import {
  getOwnerCredentialsByEmail,
  getOwnerCredentialsById,
  normalizeOwnerEmail,
  ownerIdFromEnvironment,
  type OwnerCredentials,
} from "./owner-auth-repository.mjs";
import { verifyPassword } from "./password.mjs";

export type OwnerAuthUser = { id: string; email: string };

export const OWNER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const DUMMY_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

export function normalizedOwnerEmail(value: string): string {
  return normalizeOwnerEmail(value);
}

export function validOwnerEmail(value: string): boolean {
  return OWNER_EMAIL_PATTERN.test(normalizedOwnerEmail(value));
}

export function ownerAuthUser(owner: OwnerCredentials): OwnerAuthUser {
  return { id: owner.ownerId, email: owner.email };
}

export async function authenticateOwner(emailInput: string, password: string): Promise<OwnerAuthUser | null> {
  const email = normalizedOwnerEmail(emailInput);
  if (!validOwnerEmail(email) || typeof password !== "string" || password.length === 0) return null;
  const owner = await getOwnerCredentialsByEmail(email);
  const matches = await verifyPassword(password, owner?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!owner || !matches) return null;
  let configuredOwnerId: string;
  try {
    configuredOwnerId = ownerIdFromEnvironment();
  } catch {
    return null;
  }
  return owner.ownerId === configuredOwnerId ? ownerAuthUser(owner) : null;
}

export async function ownerForSession(input: { id?: unknown; email?: unknown; sessionVersion?: unknown }): Promise<OwnerAuthUser | null> {
  if (typeof input.id !== "string" || typeof input.email !== "string") return null;
  const owner = await getOwnerCredentialsById(input.id);
  if (!owner || owner.ownerId !== ownerIdFromEnvironment() || owner.email !== normalizedOwnerEmail(input.email)) return null;
  if (typeof input.sessionVersion === "number" && owner.sessionVersion !== input.sessionVersion) return null;
  return ownerAuthUser(owner);
}
