import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { AutomationNotFoundError, deleteAutomation, getAutomation, updateAutomation } from "../../../server/automations/automation-service";

type Context = { params: Promise<{ automationId: string }> | { automationId: string } };
async function owner(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? authorizeOwnerSession(header.slice(7)) : null;
}
const failure = (error: unknown) => error instanceof AutomationNotFoundError
  ? NextResponse.json({ error: error.message }, { status: 404 })
  : NextResponse.json({ error: error instanceof Error ? error.message : "Automation request failed." }, { status: 400 });

export async function GET(request: Request, context: Context) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const item = await getAutomation(user.id, (await context.params).automationId);
    return item ? NextResponse.json({ automation: item }) : NextResponse.json({ error: "Automation not found." }, { status: 404 });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, context: Context) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ automation: await updateAutomation(user.id, (await context.params).automationId, await request.json()) });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request, context: Context) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    await deleteAutomation(user.id, (await context.params).automationId);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return failure(error); }
}
