import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { createReminder, listReminders } from "../../server/reminders/reminder-service";

export async function GET(request: Request) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ reminders: await listReminders(user.id) });
  } catch {
    return NextResponse.json({ error: "Reminders are unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ reminder: await createReminder(user.id, await request.json()) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The reminder could not be created." }, { status: 400 });
  }
}
