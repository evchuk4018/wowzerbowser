import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CONNECTOR_STATE_COOKIE = "wowzerbowser_connector_oauth";
const TTL = 10 * 60_000;

function secret(): string { const value = process.env.PIPEDREAM_CONNECT_STATE_SECRET?.trim(); if (!value) throw new Error("Connector OAuth state is not configured."); return value; }
function sign(payload: string): string { return createHmac("sha256", secret()).update(payload).digest("base64url"); }

export function createConnectorOAuthState(ownerId: string, connectorId: string) {
  const payload = Buffer.from(JSON.stringify({ ownerId, connectorId, nonce: randomBytes(24).toString("base64url"), expiresAt: Date.now() + TTL })).toString("base64url");
  return { state: `${payload}.${sign(payload)}`, cookieValue: `${payload}.${sign(payload)}` };
}

export function verifyConnectorOAuthState(value: string, cookieValue: string | undefined): { ownerId: string; connectorId: string } | null {
  if (!cookieValue || value !== cookieValue) return null;
  const [payload, provided, ...extra] = value.split(".");
  if (!payload || !provided || extra.length) return null;
  const expected = sign(payload);
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { ownerId?: unknown; connectorId?: unknown; expiresAt?: unknown };
    return typeof parsed.ownerId === "string" && typeof parsed.connectorId === "string" && typeof parsed.expiresAt === "number" && parsed.expiresAt >= Date.now() ? { ownerId: parsed.ownerId, connectorId: parsed.connectorId } : null;
  } catch { return null; }
}
