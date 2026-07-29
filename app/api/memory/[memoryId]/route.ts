import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { parseMemoryUpdate } from "../../../../lib/memory-protocol";
import {
  deleteUserMemoryFromSettings,
  updateUserMemoryFromSettings,
  UserMemoryDuplicateError,
  UserMemoryNotFoundError,
} from "../../../server/memory/memory-service";

const ID = /^[0-9a-f-]{36}$/i;

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorizeOwnerSession(authorization.slice(7))
    : null;
}

function validMemoryId(memoryId: string): boolean {
  return ID.test(memoryId);
}

export async function PATCH(request: Request, context: { params: Promise<{ memoryId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { memoryId } = await context.params;
  if (!validMemoryId(memoryId)) return NextResponse.json({ error: "Memory not found." }, { status: 404 });

  try {
    const update = parseMemoryUpdate(await request.json());
    if (!update) return NextResponse.json({ error: "Invalid memory update." }, { status: 400 });
    const memory = await updateUserMemoryFromSettings(owner.id, memoryId, update.content);
    return NextResponse.json({ memory });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof UserMemoryNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof UserMemoryDuplicateError) return NextResponse.json({ error: error.message }, { status: 409 });
    const message = error instanceof Error ? error.message : "";
    if (/memory content|secrets|storage limit/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "The memory could not be updated." }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ memoryId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { memoryId } = await context.params;
  if (!validMemoryId(memoryId)) return NextResponse.json({ error: "Memory not found." }, { status: 404 });

  try {
    await deleteUserMemoryFromSettings(owner.id, memoryId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof UserMemoryNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "The memory could not be deleted." }, { status: 503 });
  }
}
