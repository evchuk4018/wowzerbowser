import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { readArtifactDescriptor } from "../../../../server/artifacts/artifact-store";
import { readConversationArtifact } from "../../../../server/modal/modal-python-executor";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> | { artifactId: string } },
) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return unauthorizedResponse();
  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return unauthorizedResponse();

  const params = await context.params;
  const artifactId = params.artifactId;
  if (!/^[A-Za-z0-9_.-]{20,2048}$/.test(artifactId)) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }
  const artifact = readArtifactDescriptor(artifactId, user.id);
  if (!artifact) return NextResponse.json({ error: "Artifact not found." }, { status: 404 });

  try {
    const bytes = await readConversationArtifact(user.id, artifact.conversationId, artifact.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.size || digest !== artifact.sha256) {
      return NextResponse.json({ error: "Artifact has changed since it was created." }, { status: 409 });
    }
    return new Response(Buffer.from(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${artifact.name.replace(/"/g, "")}"`,
        "content-length": String(bytes.byteLength),
        "content-type": artifact.contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }
}
