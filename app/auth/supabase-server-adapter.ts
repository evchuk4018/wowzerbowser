import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { AuthUser } from "./types";

function getServerClient() {
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
  const { data, error } = await getServerClient().auth.getUser(accessToken);
  if (error || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email };
}
