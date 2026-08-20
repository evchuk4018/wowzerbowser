import { NextResponse } from "next/server";
import { parseDiscordAutomationDeliveryResult } from "../../../../../../lib/discord-protocol";
import { authorizeDiscordInternalRequest } from "../../../../../server/discord/discord-auth";
import { completeDiscordUserQuestionNotification } from "../../../../../server/discord/discord-user-question-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function PATCH(request: Request, context: { params: Promise<{ notificationId: string }> }) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  try {
    const { notificationId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(notificationId)) {
      return NextResponse.json({ error: "Notification ID is invalid." }, { status: 400 });
    }
    await completeDiscordUserQuestionNotification(
      notificationId,
      parseDiscordAutomationDeliveryResult(await request.json()),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Discord delivery update failed." },
      { status: error instanceof SyntaxError ? 400 : 422 },
    );
  }
}
