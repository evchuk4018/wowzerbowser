import { relativeWorkspacePath } from "./python-tool-policy";

export const DOCUMENT_PROJECT_LIMITS = {
  maxManifestBytes: 256 * 1024,
  maxSourceFiles: 100,
  maxFileBytes: 25 * 1024 * 1024,
  maxSourceBytes: 50 * 1024 * 1024,
} as const;
export const DOCUMENT_SOURCE_BUCKET = "chat-document-sources";
export const DOCUMENT_OUTPUT_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export type DocumentOutputContentType = (typeof DOCUMENT_OUTPUT_CONTENT_TYPES)[number];
export type DocumentSourceCompleteness = "complete" | "entrypoint-only";
export type DocumentProjectSourceFile = { path: string; size: number; sha256: string; contentType: string };
export type DocumentProjectManifestV1 = {
  schemaVersion: 1; projectId: string; revisionId: string; parentRevisionId: string | null;
  origin: "generated" | "uploaded"; createdAt: string; createdByJobId: string | null; entrypoint: string;
  outputPath: string; outputFilename: string; outputContentType: DocumentOutputContentType;
  sourceFiles: DocumentProjectSourceFile[]; outputSha256: string;
  sourceCompleteness: DocumentSourceCompleteness | null;
};

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const SHA = /^[0-9a-f]{64}$/;
export function documentProjectId(value: string, label = "document project identifier"): string {
  if (!ID.test(value)) throw new Error(`${label} must be a URL-safe server identifier.`);
  return value;
}
export const documentProjectRoot = (projectId: string) => `documents/${documentProjectId(projectId)}`;
export const documentRevisionRoot = (projectId: string, revisionId: string) => `${documentProjectRoot(projectId)}/revisions/${documentProjectId(revisionId, "revision identifier")}`;
export const documentRevisionManifestPath = (projectId: string, revisionId: string) => `${documentRevisionRoot(projectId, revisionId)}/manifest.json`;
export const documentRevisionSourcePath = (projectId: string, revisionId: string, path: string) => containedPath(`${documentRevisionRoot(projectId, revisionId)}/source`, path);
export const documentRevisionOutputPath = (projectId: string, revisionId: string, filename: string) => containedPath(`${documentRevisionRoot(projectId, revisionId)}/output`, filename);

function containedPath(root: string, child: string): string {
  const safe = relativeWorkspacePath(child);
  if (safe.startsWith("documents/")) throw new Error("Revision child paths must be relative to their canonical directory.");
  return relativeWorkspacePath(`${root}/${safe}`);
}
function isWithin(path: string, root: string): boolean { return path.startsWith(`${root}/`) && path !== root; }
export function sourceContentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "py") return "text/x-python; charset=utf-8";
  if (["txt", "md", "csv", "json", "yaml", "yml", "html", "css"].includes(extension ?? "")) return "text/plain; charset=utf-8";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
export function outputContentType(path: string): DocumentOutputContentType | null {
  if (path.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (path.toLowerCase().endsWith(".docx")) return DOCUMENT_OUTPUT_CONTENT_TYPES[1];
  return null;
}
export function validateDocumentProjectManifest(value: unknown): DocumentProjectManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Document project manifest must be an object.");
  const manifest = value as DocumentProjectManifestV1;
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  if (encoded.byteLength > DOCUMENT_PROJECT_LIMITS.maxManifestBytes) throw new Error("Document project manifest exceeds 256 KiB.");
  if (manifest.schemaVersion !== 1 || (manifest.origin !== "generated" && manifest.origin !== "uploaded")) throw new Error("Unsupported document project manifest.");
  documentProjectId(manifest.projectId); documentProjectId(manifest.revisionId, "revision identifier");
  if (manifest.parentRevisionId !== null) documentProjectId(manifest.parentRevisionId, "parent revision identifier");
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || (manifest.createdByJobId !== null && typeof manifest.createdByJobId !== "string")) throw new Error("Manifest creation metadata is invalid.");
  if (!DOCUMENT_OUTPUT_CONTENT_TYPES.includes(manifest.outputContentType)) throw new Error("Manifest output content type is invalid.");
  if (!SHA.test(manifest.outputSha256)) throw new Error("Manifest output SHA-256 is invalid.");
  if (!Array.isArray(manifest.sourceFiles) || (manifest.origin === "generated" && !manifest.sourceFiles.length) || manifest.sourceFiles.length > DOCUMENT_PROJECT_LIMITS.maxSourceFiles) throw new Error("Manifest source file count is invalid.");
  if (!(["complete", "entrypoint-only"] as unknown[]).includes(manifest.sourceCompleteness)) throw new Error("Manifest source completeness is invalid.");
  const root = documentRevisionRoot(manifest.projectId, manifest.revisionId);
  const sourceRoot = `${root}/source`; const outputRoot = `${root}/output`;
  manifest.entrypoint = relativeWorkspacePath(manifest.entrypoint); manifest.outputPath = relativeWorkspacePath(manifest.outputPath);
  if (!isWithin(manifest.entrypoint, sourceRoot) || !isWithin(manifest.outputPath, outputRoot)) throw new Error("Manifest paths must stay inside the revision directory.");
  if (manifest.outputFilename !== manifest.outputPath.slice(outputRoot.length + 1) || manifest.outputFilename.includes("/")) throw new Error("Manifest output filename does not match its output path.");
  const seen = new Set<string>(); let total = 0;
  for (const file of manifest.sourceFiles) {
    file.path = relativeWorkspacePath(file.path);
    if (!isWithin(file.path, sourceRoot) || seen.has(file.path)) throw new Error("Manifest contains an invalid or duplicate source path.");
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > DOCUMENT_PROJECT_LIMITS.maxFileBytes || !SHA.test(file.sha256) || typeof file.contentType !== "string" || !file.contentType) throw new Error("Manifest source metadata is invalid.");
    total += file.size;
  }
  if (total > DOCUMENT_PROJECT_LIMITS.maxSourceBytes) throw new Error("Manifest source tree is too large.");
  if (!seen.has(manifest.entrypoint)) throw new Error("Manifest entrypoint must be included in sourceFiles.");
  return manifest;
}
