import { supabaseBrowserAuth } from "./supabase-browser-adapter";
import type { AuthSession, AuthUser } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getCurrentUser(): Promise<AuthUser | null> {
  return authorizeSession(await supabaseBrowserAuth.getSession());
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
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not send the magic link.");
  }
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
