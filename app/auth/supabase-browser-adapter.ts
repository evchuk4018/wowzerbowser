import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { AuthSession, AuthUser } from "./types";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error("Supabase authentication is not configured.");
  }

  client = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });

  return client;
}

function mapUser(user: User | null): AuthUser | null {
  if (!user?.email) return null;
  return { id: user.id, email: user.email };
}

export const supabaseBrowserAuth = {
  async getSession(): Promise<AuthSession | null> {
    const supabase = getClient();
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) return null;

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const user = mapUser(userData.user);
    const { data: refreshedSessionData, error: refreshedSessionError } =
      await supabase.auth.getSession();
    if (refreshedSessionError) throw refreshedSessionError;
    const refreshedSession = refreshedSessionData.session;
    return user
      ? { accessToken: refreshedSession?.access_token ?? sessionData.session.access_token, user }
      : null;
  },

  async signOut(): Promise<void> {
    const { error } = await getClient().auth.signOut();
    if (error) throw error;
  },

  onSessionChange(listener: (session: AuthSession | null) => void): () => void {
    const { data } = getClient().auth.onAuthStateChange((_event, session) => {
      const user = mapUser(session?.user ?? null);
      listener(session && user ? { accessToken: session.access_token, user } : null);
    });
    return () => data.subscription.unsubscribe();
  },
};
