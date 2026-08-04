import "server-only";

import { getOwnerCredentialsById, ownerIdFromEnvironment } from "../server/auth/owner-auth-repository.mjs";
import { ownerAuthUser, ownerForSession, normalizedOwnerEmail, type OwnerAuthUser } from "../server/auth/owner-credential-service";

export type AuthUser = OwnerAuthUser;

async function currentAuthSession() {
  const { auth } = await import("../../auth");
  return auth();
}

function configuredOrigin(): string | null {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function headerOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function authDebug(request: Request, message: string, details: Record<string, unknown> = {}): void {
  if (process.env.AUTH_DEBUG !== "1") return;
  let pathname = "unknown";
  let requestUrlOrigin = "unknown";
  try {
    const url = new URL(request.url);
    pathname = url.pathname;
    requestUrlOrigin = url.origin;
  } catch {}
  console.warn("[auth]", message, {
    method: request.method,
    pathname,
    requestUrlOrigin,
    requestOrigin: headerOrigin(request.headers.get("origin")),
    refererOrigin: headerOrigin(request.headers.get("referer")),
    configuredOrigin: configuredOrigin(),
    hasSessionCookie: Boolean(request.headers.get("cookie")),
    ...details,
  });
}

export function sameOriginRequest(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const requestOrigin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!requestOrigin) return false;
  try {
    const origin = new URL(requestOrigin).origin;
    return origin === (configuredOrigin() ?? new URL(request.url).origin);
  } catch {
    return false;
  }
}

export async function getCurrentOwner(): Promise<AuthUser | null> {
  const session = await currentAuthSession();
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  return ownerForSession({
    id: user.id,
    email: normalizedOwnerEmail(user.email),
    sessionVersion: (session as { sessionVersion?: unknown }).sessionVersion,
  });
}

export async function authorizeOwnerSession(request: Request): Promise<AuthUser | null> {
  if (!sameOriginRequest(request)) {
    authDebug(request, "rejected request origin");
    return null;
  }
  try {
    const owner = await getCurrentOwner();
    if (!owner) authDebug(request, "owner session unavailable");
    return owner;
  } catch (error) {
    authDebug(request, "owner session lookup failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

export async function configuredOwner(): Promise<AuthUser> {
  const owner = await getOwnerCredentialsById(ownerIdFromEnvironment());
  if (!owner) throw new Error("The owner credentials have not been bootstrapped.");
  return ownerAuthUser(owner);
}
