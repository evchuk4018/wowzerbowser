"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getCurrentAccessToken,
  getCurrentUser,
  requestMagicLink,
  signOut,
  subscribeToAuth,
} from "./auth-service";
import type { AuthState } from "./types";

const INITIAL_STATE: AuthState = { status: "loading", user: null, error: null };

export function useAuthSession() {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  useEffect(() => {
    let active = true;

    getCurrentUser()
      .then((user) => {
        if (!active) return;
        setState(
          user
            ? { status: "authenticated", user, error: null }
            : { status: "anonymous", user: null, error: null },
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          user: null,
          error: error instanceof Error ? error.message : "Authentication is unavailable.",
        });
      });

    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeToAuth((user) => {
        if (!active) return;
        setState(
          user
            ? { status: "authenticated", user, error: null }
            : { status: "anonymous", user: null, error: null },
        );
      });
    } catch (error: unknown) {
      queueMicrotask(() => {
        if (!active) return;
        setState({
          status: "error",
          user: null,
          error: error instanceof Error ? error.message : "Authentication is unavailable.",
        });
      });
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const sendMagicLink = useCallback((email: string) => requestMagicLink(email), []);
  const endSession = useCallback(async () => {
    try {
      await signOut();
    } catch (error: unknown) {
      setState({
        status: "error",
        user: null,
        error: error instanceof Error ? error.message : "Could not sign out.",
      });
    }
  }, []);

  return { state, sendMagicLink, signOut: endSession, getAccessToken: getCurrentAccessToken };
}
