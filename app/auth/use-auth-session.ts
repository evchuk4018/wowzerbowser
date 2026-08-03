"use client";

import { useCallback, useEffect, useState } from "react";
import { getCurrentUser, signInWithPassword, signOut } from "./auth-service";
import type { AuthState } from "./types";

const INITIAL_STATE: AuthState = { status: "loading", user: null, error: null };

export function useAuthSession() {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  const refresh = useCallback(async () => {
    try {
      const user = await getCurrentUser();
      setState(user ? { status: "authenticated", user, error: null } : { status: "anonymous", user: null, error: null });
    } catch (error: unknown) {
      setState({ status: "error", user: null, error: error instanceof Error ? error.message : "Authentication is unavailable." });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const passwordSignIn = useCallback((email: string, password: string, callbackUrl?: string) => signInWithPassword(email, password, callbackUrl), []);
  const endSession = useCallback(async () => {
    try {
      await signOut();
      setState({ status: "anonymous", user: null, error: null });
    } catch (error: unknown) {
      setState({ status: "error", user: null, error: error instanceof Error ? error.message : "Could not sign out." });
    }
  }, []);

  // API requests authenticate with the HttpOnly Auth.js cookie. This helper
  // only lets UI flows fail early when the session has disappeared.
  const hasSession = useCallback(async () => Boolean(await getCurrentUser()), []);

  return { state, signInWithPassword: passwordSignIn, signOut: endSession, invalidateSession: endSession, refresh, hasSession };
}
