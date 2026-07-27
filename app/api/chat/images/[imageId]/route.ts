import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { ChatImageError, isValidChatImageId } from "../../../../../lib/chat-image";
import { readChatImagePreviewForOwner } from "../../../../server/chat/chat-image-service";

export function createChatImageReadHandler(dependencies = {
  authorizeOwnerSession,
  readChatImagePreviewForOwner,
}) {
  return async function GET(request: Request, context: { params: Promise<{ imageId: string }> }) {
    const authorization = request.headers.get("authorization");
    const owner = authorization?.startsWith("Bearer ")
      ? await dependencies.authorizeOwnerSession(authorization.slice(7))
      : null;
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { imageId } = await context.params;
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!isValidChatImageId(conversationId) || !isValidChatImageId(imageId)) {
      return NextResponse.json({ error: "Image not found." }, { status: 404 });
    }
    try {
      const image = await dependencies.readChatImagePreviewForOwner({ ownerId: owner.id, conversationId, imageId });
      return new Response(new Blob([Buffer.from(image.bytes)]), {
        status: 200,
        headers: {
          "content-type": image.contentType,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof ChatImageError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "The image could not be loaded." }, { status: 503 });
    }
  };
}

export const GET = createChatImageReadHandler();
