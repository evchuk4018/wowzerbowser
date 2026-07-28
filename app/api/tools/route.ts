import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { createOwnerCustomTool, listOwnerCustomTools } from "../../server/tools/custom-tool-service";

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorizeOwnerSession(authorization.slice(7)) : null;
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ tools: await listOwnerCustomTools(owner.id) });
  } catch {
    return NextResponse.json({ error: "Tools are unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const tool = await createOwnerCustomTool(owner.id, await request.json());
    return NextResponse.json({ tool }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (/invalid|must|reserved|unsupported|too many|too large/i.test(message)) return NextResponse.json({ error: message }, { status: 400 });
    if (/duplicate|unique/i.test(message)) return NextResponse.json({ error: "A tool with that name already exists." }, { status: 409 });
    return NextResponse.json({ error: "The tool could not be created." }, { status: 503 });
  }
}
