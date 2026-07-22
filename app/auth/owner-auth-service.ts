import "server-only";

import { sendSupabaseMagicLink, verifySupabaseAccessToken } from "./supabase-server-adapter";
import type { AuthUser } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ownerEmail(): string {
  const email = process.env.APP_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("APP_OWNER_EMAIL is not configured.");
  return email;
}

export async function sendOwnerMagicLink(emailInput: string): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error("Enter a valid email address.");

  // Return normally for non-owner addresses so the endpoint does not disclose the allowlist.
  if (email !== ownerEmail()) return;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  await sendSupabaseMagicLink(email, new URL("/", siteUrl).toString());
}

export async function authorizeOwnerSession(accessToken: string): Promise<AuthUser | null> {
  const user = await verifySupabaseAccessToken(accessToken);
  return user?.email.toLowerCase() === ownerEmail() ? user : null;
}
