import { after } from "next/server";
import { NextResponse } from "next/server";
import { parseDiscordInboundMessage } from "../../../../../lib/discord-protocol";
import { authorizeDiscordInternalRequest } from "../../../../server/discord/discord-auth";
import {
  pendingDiscordSubmissions,
  submitDiscordMessage,
} from "../../../../server/discord/discord-chat-service";

export const maxDuration = 300;
const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function POST(request: Request) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  if (Number(request.headers.get("content-length") ?? "0") > 100_000) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }
  try {
    const result = await submitDiscordMessage(parseDiscordInboundMessage(await request.json()));
    if (result.completion) after(() => result.completion!);
    return NextResponse.json(result.submission, { status: result.completion ? 202 : 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Discord submission failed." },
      { status: error instanceof SyntaxError ? 400 : 422 },
    );
  }
}

export async function GET(request: Request) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  try {
    return NextResponse.json({ submissions: await pendingDiscordSubmissions() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Discord submissions are unavailable." },
      { status: 503 },
    );
  }
}
