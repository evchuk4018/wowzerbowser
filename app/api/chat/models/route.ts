import { NextResponse } from "next/server";
import { isChatModelRef } from "../../../../lib/chat-protocol";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { CatalogQueryError } from "../../../server/chat/chat-model-catalog-query";
import { ChatModelAuthorizationError, composerChatModels, discoverChatModels, enableChatModel, visionChatModels } from "../../../server/chat/chat-model-catalog-service";
import { OpenRouterError } from "../../../providers/openrouter/openrouter-catalog-adapter";

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorizeOwnerSession(authorization.slice(7)) : null;
}
export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("scope") === "catalog") return NextResponse.json(await discoverChatModels(owner.id, url.searchParams));
    if (url.searchParams.get("scope") === "vision") return NextResponse.json({ models: await visionChatModels(owner.id) });
    if ([...url.searchParams.keys()].length) return NextResponse.json({ error: "scope must be catalog." }, { status: 400 });
    return NextResponse.json({ models: await composerChatModels(owner.id) });
  } catch (error) {
    const status = error instanceof CatalogQueryError ? 400 : error instanceof OpenRouterError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Models are unavailable." }, { status });
  }
}
export async function PUT(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const ref = { provider: body.provider, model: body.model };
    if (!isChatModelRef(ref) || ref.provider !== "openrouter" || typeof body.enabled !== "boolean") return NextResponse.json({ error: "Invalid model enablement." }, { status: 400 });
    await enableChatModel(owner.id, ref, body.enabled);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const status = error instanceof ChatModelAuthorizationError ? 400 : error instanceof OpenRouterError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Model enablement is unavailable." }, { status });
  }
}
