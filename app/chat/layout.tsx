import { configuredOwner } from "../auth/owner-auth-service";
import { ChatPage } from "./chat-page";

export const dynamic = "force-dynamic";

/** Single-user workspace: the configured owner is always available. */
export default function ChatLayout() {
  return <ChatPage user={configuredOwner()} />;
}