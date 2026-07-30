import { NextResponse } from "next/server";
import { authorizeDiscordInternalRequest } from "../../../../../server/discord/discord-auth";
import {
  confirmDiscordDelivery,
  discordSubmission,
} from "../../../../../server/discord/discord-chat-service";

type Context = { params: Promise<{ messageId: string }> };
const idPattern = /^\d{1,24}$/;
const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request, context: Context) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  const { messageId } = await context.params;
  if (!idPattern.test(messageId)) return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  try {
    const submission = await discordSubmission(messageId);
    return submission
      ? NextResponse.json(submission)
      : NextResponse.json({ error: "Submission not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Discord submission is unavailable." },
      { status: 503 },
    );
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  const { messageId } = await context.params;
  if (!idPattern.test(messageId)) return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  try {
    const body = await request.json() as { delivered?: unknown };
    if (body.delivered !== true) return NextResponse.json({ error: "delivered must be true." }, { status: 400 });
    await confirmDiscordDelivery(messageId);
    return NextResponse.json({ delivered: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Discord delivery could not be confirmed." },
      { status: 503 },
    );
  }
}
