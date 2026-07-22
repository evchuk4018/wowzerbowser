import { NextResponse } from "next/server";
import { sendOwnerMagicLink } from "../../../auth/owner-auth-service";

export async function POST(request: Request) {
  let email: unknown;
  try {
    ({ email } = (await request.json()) as { email?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof email !== "string") {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  try {
    await sendOwnerMagicLink(email);
    return NextResponse.json({ sent: true }, { status: 202 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not send the magic link.";
    const status = message === "Enter a valid email address." ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
