import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { parseCustomToolTestInput } from "../../../../../lib/custom-tool-protocol";
import { getExecutableCustomTool } from "../../../../server/tools/custom-tool-repository";
import { runCustomTool } from "../../../../server/tools/custom-tool-executor";

const ID = /^[0-9a-f-]{36}$/i;

export async function POST(request: Request, context: { params: Promise<{ toolId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { toolId } = await context.params;
  if (!ID.test(toolId)) return NextResponse.json({ error: "Tool not found." }, { status: 404 });
  try {
    const body = await request.json() as { input?: unknown };
    const tool = await getExecutableCustomTool(owner.id, toolId);
    if (!tool) return NextResponse.json({ error: "Tool not found." }, { status: 404 });
    return NextResponse.json({ result: await runCustomTool(tool, parseCustomToolTestInput(body.input)) });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (/large|must|required|allowed/i.test(message)) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: "The tool could not be tested." }, { status: 503 });
  }
}
