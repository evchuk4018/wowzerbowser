import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatArtifact } from "../../../lib/chat-protocol";
import { relativeWorkspacePath } from "../modal/modal-python-executor";

type ArtifactDescriptor = {
  ownerId: string;
  conversationId: string;
  path: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
};

function signingKey(): string {
  const value = process.env.ARTIFACT_SIGNING_SECRET?.trim();
  if (!value) throw new Error("Artifact signing is not configured.");
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function registerArtifact(input: ArtifactDescriptor): ChatArtifact {
  const descriptor: ArtifactDescriptor = {
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    path: relativeWorkspacePath(input.path),
    name: input.name.replace(/[\\/]/g, "_").slice(0, 160) || "artifact",
    contentType: input.contentType || "application/octet-stream",
    size: input.size,
    sha256: input.sha256,
  };
  const payload = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url");
  return {
    id: `${payload}.${signature(payload)}`,
    name: descriptor.name,
    contentType: descriptor.contentType,
    size: descriptor.size,
  };
}

export function readArtifactDescriptor(id: string, ownerId: string): ArtifactDescriptor | null {
  try {
    const separator = id.lastIndexOf(".");
    if (separator <= 0) return null;
    const payload = id.slice(0, separator);
    const suppliedSignature = id.slice(separator + 1);
    const expectedSignature = signature(payload);
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ArtifactDescriptor;
    if (
      value.ownerId !== ownerId ||
      typeof value.conversationId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.contentType !== "string" ||
      typeof value.size !== "number" ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
      return null;
    }
    return { ...value, path: relativeWorkspacePath(value.path) };
  } catch {
    return null;
  }
}
