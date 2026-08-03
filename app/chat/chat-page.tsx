"use client";

import { useCallback, useState } from "react";
import { LoginForm } from "../auth/login-form";
import { useAuthSession } from "../auth/use-auth-session";
import { ChatWorkspace } from "./chat-workspace";
import { ChatStartupShell } from "./chat-startup-shell";
import { clearChatStartupSnapshot } from "./use-chat-startup-snapshot";

export function ChatPage() {
  const {
    state,
    signOut,
    invalidateSession,
    hasSession,
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
    return <LoginForm error={state.status === "error" ? state.error : null} />;
  }

  return (
    <ChatWorkspace
      key={state.user.id}
      user={state.user}
      hasSession={hasSession}
      initialDraft={startupDraft}
      onSignOut={handleSignOut}
      onSessionInvalid={handleSessionInvalid}
    />
  );
}
