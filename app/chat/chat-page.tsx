"use client";

import type { AuthUser } from "../auth/types";
import { ChatWorkspace } from "./chat-workspace";

export function ChatPage({ user }: { user: AuthUser }) {
  return <ChatWorkspace user={user} hasSession={() => Promise.resolve(true)} />;
}