export async function generateChatTitle(firstTurn: string, conversationId: string, accessToken: string): Promise<string> {
  const response = await fetch("/api/chat/title", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ firstTurn, conversationId }),
  });
  if (!response.ok) throw new Error("The chat could not be named.");
  const body = await response.json() as { title?: unknown };
  if (typeof body.title !== "string") throw new Error("The chat could not be named.");
  return body.title;
}
