import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import {
  cancelReminder,
  getReminder,
  ReminderNotFoundError,
  ReminderStateError,
  updateReminder,
} from "../../../server/reminders/reminder-service";

type Context = { params: Promise<{ reminderId: string }> | { reminderId: string } };

const failure = (error: unknown) => error instanceof ReminderNotFoundError
  ? NextResponse.json({ error: error.message }, { status: 404 })
  : error instanceof ReminderStateError
    ? NextResponse.json({ error: error.message }, { status: 409 })
    : NextResponse.json({ error: error instanceof Error ? error.message : "Reminder request failed." }, { status: 400 });

export async function GET(request: Request, context: Context) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const reminder = await getReminder(user.id, (await context.params).reminderId);
    return reminder ? NextResponse.json({ reminder }) : NextResponse.json({ error: "Reminder not found." }, { status: 404 });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, context: Context) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ reminder: await updateReminder(user.id, (await context.params).reminderId, await request.json()) });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request, context: Context) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ reminder: await cancelReminder(user.id, (await context.params).reminderId) });
  } catch (error) { return failure(error); }
}
