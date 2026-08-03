import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { deleteOwnerCustomTool, readOwnerCustomTool, updateOwnerCustomTool } from "../../../server/tools/custom-tool-service";

const ID = /^[0-9a-f-]{36}$/i;
async function ownerFor(request: Request) {
  return authorizeOwnerSession(request);
}

export async function GET(request: Request, context: { params: Promise<{ toolId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { toolId } = await context.params;
  if (!ID.test(toolId)) return NextResponse.json({ error: "Tool not found." }, { status: 404 });
  try {
    const tool = await readOwnerCustomTool(owner.id, toolId);
    return tool ? NextResponse.json({ tool }) : NextResponse.json({ error: "Tool not found." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Tools are unavailable." }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ toolId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { toolId } = await context.params;
  if (!ID.test(toolId)) return NextResponse.json({ error: "Tool not found." }, { status: 404 });
  try {
    const tool = await updateOwnerCustomTool(owner.id, toolId, await request.json());
    return tool ? NextResponse.json({ tool }) : NextResponse.json({ error: "Tool not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (/invalid|must|reserved|unsupported|too many|too large/i.test(message)) return NextResponse.json({ error: message }, { status: 400 });
    if (/duplicate|unique/i.test(message)) return NextResponse.json({ error: "A tool with that name already exists." }, { status: 409 });
    return NextResponse.json({ error: "The tool could not be updated." }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ toolId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { toolId } = await context.params;
  if (!ID.test(toolId)) return NextResponse.json({ error: "Tool not found." }, { status: 404 });
  try {
    return await deleteOwnerCustomTool(owner.id, toolId)
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json({ error: "Tool not found." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "The tool could not be deleted." }, { status: 503 });
  }
}
