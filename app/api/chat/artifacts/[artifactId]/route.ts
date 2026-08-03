import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { readArtifactDescriptor } from "../../../../server/artifacts/artifact-store";
import { openOwnedStorageObject } from "../../../../server/storage/storage-service";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export function createArtifactReadHandler(dependencies = {
  authorizeOwnerSession,
  readArtifactDescriptor,
  openOwnedStorageObject,
}) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ artifactId: string }> | { artifactId: string } },
  ) {
    const user = await dependencies.authorizeOwnerSession(request);
    if (!user) return unauthorizedResponse();

    const params = await context.params;
    const artifactId = params.artifactId;
    if (!/^[A-Za-z0-9_.-]{20,2048}$/.test(artifactId)) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }
    const artifact = dependencies.readArtifactDescriptor(artifactId, user.id);
    if (!artifact) return NextResponse.json({ error: "Artifact not found." }, { status: 404 });

    try {
      const opened = await dependencies.openOwnedStorageObject({ ownerId: user.id, objectId: artifact.objectId, conversationId: artifact.conversationId });
      if (
        opened.size !== artifact.size
        || opened.object.sha256 !== artifact.sha256
        || opened.object.contentType !== artifact.contentType
      ) {
        return NextResponse.json({ error: "Artifact has changed since it was created." }, { status: 409 });
      }
      return new Response(opened.stream, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": "attachment; filename=\"" + artifact.name.replace(/[\"\\\r\n]/g, "_") + "\"",
          "content-length": String(opened.size),
          "content-type": artifact.contentType,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }
  };
}

export const GET = createArtifactReadHandler();
