import { ChatPage } from "../chat-page";

export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <ChatPage initialConversationId={conversationId} />;
}
