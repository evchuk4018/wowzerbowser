import { supabaseBrowserAuth } from "./supabase-browser-adapter";
import type { AuthSession, AuthUser } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class MagicLinkRateLimitError extends Error {
  readonly code = "magic_link_rate_limited";

  constructor() {
    super("Magic links are temporarily rate-limited.");
    this.name = "MagicLinkRateLimitError";
  }
}

export function isMagicLinkRateLimitError(error: unknown): error is MagicLinkRateLimitError {
  return error instanceof MagicLinkRateLimitError;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  return authorizeSession(await supabaseBrowserAuth.getSession());
}

export async function getCurrentAccessToken(): Promise<string | null> {
  return (await supabaseBrowserAuth.getSession())?.accessToken ?? null;
}

export function subscribeToAuth(listener: (user: AuthUser | null) => void): () => void {
  return supabaseBrowserAuth.onSessionChange((session) => {
    void authorizeSession(session).then(listener).catch(() => listener(null));
  });
}

export async function requestMagicLink(emailInput: string): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error("Enter a valid email address.");
  }

  const response = await fetch("/api/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { code?: string; error?: string }
      | null;
    if (body?.code === "magic_link_rate_limited" || response.status === 429) {
      throw new MagicLinkRateLimitError();
    }
    throw new Error(body?.error ?? "Could not send the magic link.");
  }
}

export async function signInWithPassword(emailInput: string, password: string): Promise<void> {
  const email = normalizeEmail(emailInput);
  validateEmail(email);
  await supabaseBrowserAuth.signInWithPassword(email, password);
}

export async function signUpWithPassword(emailInput: string, password: string): Promise<void> {
  const email = normalizeEmail(emailInput);
  validateEmail(email);
  await supabaseBrowserAuth.signUpWithPassword(email, password);
}

export async function signOut(): Promise<void> {
  await supabaseBrowserAuth.signOut();
}

async function authorizeSession(session: AuthSession | null): Promise<AuthUser | null> {
  if (!session) return null;

  const response = await fetch("/api/auth/session", {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });

  if (!response.ok) {
    await supabaseBrowserAuth.signOut();
    return null;
  }

  const body = (await response.json()) as { user?: AuthUser };
  return body.user ?? null;
}

function normalizeEmail(emailInput: string): string {
  return emailInput.trim().toLowerCase();
}

function validateEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email)) throw new Error("Enter a valid email address.");
}
