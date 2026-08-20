import { NextResponse } from "next/server";
import { authorizeDiscordInternalRequest } from "../../../server/discord/discord-auth";
import { pendingUserQuestionsForDiscord } from "../../../server/user-questions/user-question-discord-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  try {
    const questions = await pendingUserQuestionsForDiscord();
    return NextResponse.json({ questions });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "User questions are unavailable." }, { status: 503 });
  }
}
