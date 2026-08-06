import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { readWorkspaceAsset, WorkspaceRequestError } from "../../../../../../server/workspace/workspace-service";

export const runtime = "nodejs";

function errorResponse(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function htmlPreviewPolicy(contentType: string): string | undefined {
  if (!contentType.startsWith("text/html")) return undefined;
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "base-uri 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string; path: string[] }> },
) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return errorResponse(401, "Unauthorized.");

  try {
    const { conversationId, path } = await context.params;
    if (!Array.isArray(path) || path.length === 0) return errorResponse(404, "Workspace file not found.");
    const asset = await readWorkspaceAsset(owner.id, conversationId, path.join("/"));
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${asset.file.name.replace(/["\\\r\n]/g, "_")}"`,
      "content-length": String(asset.bytes.byteLength),
      "content-type": asset.file.contentType,
      "x-content-type-options": "nosniff",
    });
    const contentSecurityPolicy = htmlPreviewPolicy(asset.file.contentType);
    if (contentSecurityPolicy) headers.set("content-security-policy", contentSecurityPolicy);
    return new Response(asset.bytes as BodyInit, { headers });
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 503;
    return errorResponse(status, error instanceof Error ? error.message : "Workspace unavailable.");
  }
}
