import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { AuthSession, AuthUser } from "./types";

let client: SupabaseClient | null = null;
let cachedSession: AuthSession | null | undefined;
let sessionPromise: Promise<AuthSession | null> | null = null;

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
    if (cachedSession !== undefined) return cachedSession;
    if (sessionPromise) return sessionPromise;
    const supabase = getClient();
    sessionPromise = supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      cachedSession = mapSession(data.session);
      return cachedSession;
    }).finally(() => { sessionPromise = null; });
    return sessionPromise;
  },

  async signOut(): Promise<void> {
    const { error } = await getClient().auth.signOut();
    if (error) throw error;
    cachedSession = null;
  },

  async signInWithPassword(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    const session = mapSession(data.session);
    if (!session) throw new Error("Password sign-in did not create a session.");
    cachedSession = session;
    return session;
  },

  async signUpWithPassword(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw error;
    const session = mapSession(data.session);
    if (!session) {
      throw new Error("Account created, but email confirmation is enabled. Disable it in Supabase to sign in automatically.");
    }
    cachedSession = session;
    return session;
  },

  onSessionChange(listener: (session: AuthSession | null) => void): () => void {
    const { data } = getClient().auth.onAuthStateChange((_event, session) => {
      cachedSession = mapSession(session);
      listener(cachedSession);
    });
    return () => data.subscription.unsubscribe();
  },
};
