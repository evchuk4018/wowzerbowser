import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CONNECTOR_STATE_COOKIE = "wowzerbowser_connector_oauth";
const TTL = 10 * 60_000;

function secret(connectorId?: string): string {
  const name = connectorId === "gmail" ? "GOOGLE_OAUTH_STATE_SECRET" : "PIPEDREAM_CONNECT_STATE_SECRET";
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}
function sign(payload: string, connectorId?: string): string { return createHmac("sha256", secret(connectorId)).update(payload).digest("base64url"); }

export function createConnectorOAuthState(ownerId: string, connectorId: string) {
  const payload = Buffer.from(JSON.stringify({ ownerId, connectorId, nonce: randomBytes(24).toString("base64url"), expiresAt: Date.now() + TTL })).toString("base64url");
  return { state: `${payload}.${sign(payload, connectorId)}`, cookieValue: `${payload}.${sign(payload, connectorId)}` };
}

export function verifyConnectorOAuthState(value: string, cookieValue: string | undefined): { ownerId: string; connectorId: string } | null {
  if (!cookieValue || value !== cookieValue) return null;
  const [payload, provided, ...extra] = value.split(".");
  if (!payload || !provided || extra.length) return null;
  let connectorId: string | undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { connectorId?: unknown };
    connectorId = typeof parsed.connectorId === "string" ? parsed.connectorId : undefined;
  } catch { return null; }
  const expected = sign(payload, connectorId);
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { ownerId?: unknown; connectorId?: unknown; expiresAt?: unknown };
    return typeof parsed.ownerId === "string" && typeof parsed.connectorId === "string" && typeof parsed.expiresAt === "number" && parsed.expiresAt >= Date.now() ? { ownerId: parsed.ownerId, connectorId: parsed.connectorId } : null;
  } catch { return null; }
}
