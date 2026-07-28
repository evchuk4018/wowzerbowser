"use client";

import { MagicLinkForm } from "../auth/magic-link-form";
import { useAuthSession } from "../auth/use-auth-session";
import { ChatWorkspace } from "./chat-workspace";

export type ChatPageProps = {
  initialConversationId?: string;
};

export function ChatPage({ initialConversationId }: ChatPageProps) {
  const {
    state,
    sendMagicLink,
    signInWithPassword,
    signUpWithPassword,
    signOut,
    getAccessToken,
  } = useAuthSession();

  if (state.status === "loading") {
    return <main className="loading-shell" aria-label="Loading session" />;
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
      onSignOut={signOut}
      initialConversationId={initialConversationId}
    />
  );
}
