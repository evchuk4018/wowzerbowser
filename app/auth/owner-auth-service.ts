import "server-only";

export type AuthUser = { id: string; email: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function configuredOwner(): AuthUser {
  const id = process.env.APP_OWNER_ID?.trim();
  if (!id || !UUID_PATTERN.test(id)) throw new Error("APP_OWNER_ID must be configured as a server-only UUID.");
  const email = process.env.APP_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("APP_OWNER_EMAIL must be configured.");
  return { id, email };
}

export async function authorizeOwnerSession(_request?: Request): Promise<AuthUser> {
  return configuredOwner();
}