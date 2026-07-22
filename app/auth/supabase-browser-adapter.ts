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

function mapSession(session: { access_token: string; user: User } | null): AuthSession | null {
  const user = mapUser(session?.user ?? null);
  return session && user ? { accessToken: session.access_token, user } : null;
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

  async signInWithPassword(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    const session = mapSession(data.session);
    if (!session) throw new Error("Password sign-in did not create a session.");
    return session;
  },

  async signUpWithPassword(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw error;
    const session = mapSession(data.session);
    if (!session) {
      throw new Error("Account created, but email confirmation is enabled. Disable it in Supabase to sign in automatically.");
    }
    return session;
  },

  onSessionChange(listener: (session: AuthSession | null) => void): () => void {
    const { data } = getClient().auth.onAuthStateChange((_event, session) => {
      listener(mapSession(session));
    });
    return () => data.subscription.unsubscribe();
  },
};
