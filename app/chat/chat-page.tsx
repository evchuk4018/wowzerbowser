"use client";

import { useCallback, useState } from "react";
import { MagicLinkForm } from "../auth/magic-link-form";
import { useAuthSession } from "../auth/use-auth-session";
import { ChatWorkspace } from "./chat-workspace";
import { ChatStartupShell } from "./chat-startup-shell";
import { clearChatStartupSnapshot } from "./use-chat-startup-snapshot";

export function ChatPage() {
  const {
    state,
    sendMagicLink,
    signInWithPassword,
    signUpWithPassword,
    signOut,
    invalidateSession,
    getAccessToken,
  } = useAuthSession();
  const [startupDraft, setStartupDraft] = useState("");
  const clearCurrentUserSnapshot = useCallback(async (userId: string | null) => {
    if (userId) await clearChatStartupSnapshot(userId);
  }, []);
  const handleSignOut = useCallback(async () => {
    const userId = state.status === "authenticated" ? state.user.id : null;
    await Promise.allSettled([
      clearCurrentUserSnapshot(userId),
      signOut(),
    ]);
  }, [clearCurrentUserSnapshot, signOut, state]);
  const handleSessionInvalid = useCallback(async () => {
    const userId = state.status === "authenticated" ? state.user.id : null;
    await Promise.allSettled([
      clearCurrentUserSnapshot(userId),
      invalidateSession(),
    ]);
  }, [clearCurrentUserSnapshot, invalidateSession, state]);

  if (state.status === "loading") {
    return <ChatStartupShell draft={startupDraft} onDraftChange={(event) => setStartupDraft(event.target.value)} />;
  }

  if (state.status !== "authenticated") {
    return (
      <MagicLinkForm
        error={state.status === "error" ? state.error : null}
        onSubmit={sendMagicLink}
        onPasswordSignIn={signInWithPassword}
        onPasswordSignUp={signUpWithPassword}
      />
    );
  }

  return (
    <ChatWorkspace
      key={state.user.id}
      user={state.user}
      getAccessToken={getAccessToken}
      initialDraft={startupDraft}
      onSignOut={handleSignOut}
      onSessionInvalid={handleSessionInvalid}
    />
  );
}
