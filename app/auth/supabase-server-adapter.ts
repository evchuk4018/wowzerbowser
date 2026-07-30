import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { AuthUser } from "./types";

export function getServerClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("Server-side Supabase authentication is not configured.");
  }

  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function sendSupabaseMagicLink(email: string, redirectTo: string): Promise<void> {
  const { error } = await getServerClient().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
  });
  if (error) throw error;
}

export async function verifySupabaseAccessToken(accessToken: string): Promise<AuthUser | null> {
  const auth = getServerClient().auth;
  const { data: claimData, error: claimError } = await auth.getClaims(accessToken);
  const claims = claimData?.claims;
  if (!claimError && typeof claims?.sub === "string" && typeof claims.email === "string") {
    return { id: claims.sub, email: claims.email };
  }

  // Legacy symmetric projects and key-fetch failures cannot always be checked
  // locally. Preserve the remote Auth validation as a compatibility fallback.
  const { data, error } = await auth.getUser(accessToken);
  if (error || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email };
}

export async function findSupabaseUserByEmail(email: string): Promise<AuthUser | null> {
  const normalized = email.trim().toLowerCase();
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await getServerClient().auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === normalized);
    if (match?.email) return { id: match.id, email: match.email };
    if (data.users.length < 100) return null;
  }
  throw new Error("The configured owner could not be resolved.");
}
