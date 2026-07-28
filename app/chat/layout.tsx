import { ChatPage } from "./chat-page";

/** Keep the authenticated workspace mounted while conversation routes change. */
export default function ChatLayout() {
  return <ChatPage />;
}
