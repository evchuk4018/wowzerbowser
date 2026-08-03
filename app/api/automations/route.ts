import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { createAutomation, listAutomations } from "../../server/automations/automation-service";

async function owner(request: Request) {
  return authorizeOwnerSession(request);
}

export async function GET(request: Request) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ automations: await listAutomations(user.id) });
  } catch {
    return NextResponse.json({ error: "Automations are unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ automation: await createAutomation(user.id, await request.json()) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The automation could not be created." }, { status: 400 });
  }
}
