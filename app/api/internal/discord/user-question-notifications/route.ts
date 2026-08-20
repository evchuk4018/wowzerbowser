import { NextResponse } from "next/server";
import { authorizeDiscordInternalRequest } from "../../../../server/discord/discord-auth";
import { pendingDiscordUserQuestionNotifications } from "../../../../server/discord/discord-user-question-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  try {
    return NextResponse.json({ notifications: await pendingDiscordUserQuestionNotifications() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Discord user question notifications are unavailable." },
      { status: 503 },
    );
  }
}
