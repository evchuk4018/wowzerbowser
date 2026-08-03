import { redirect } from "next/navigation";
import { getCurrentOwner } from "../auth/owner-auth-service";
import { ChatPage } from "./chat-page";

export const dynamic = "force-dynamic";

/** Keep the authenticated workspace mounted while conversation routes change. */
export default async function ChatLayout() {
  const owner = await getCurrentOwner().catch(() => null);
  if (!owner) redirect("/login?callbackUrl=/chat");
  return <ChatPage />;
}
