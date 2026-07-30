import "server-only";

import { timingSafeEqual } from "node:crypto";

function configuredSecret(): Buffer | null {
  const secret = process.env.DISCORD_INTERNAL_SECRET?.trim();
  if (!secret || secret.length < 32) return null;
  return Buffer.from(secret);
}

export function authorizeDiscordInternalRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = configuredSecret();
  if (!expected) return false;
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
