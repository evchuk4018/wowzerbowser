import type { ChatArtifact } from "../../lib/chat-protocol";

function decodedBasename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? "";
  const normalized = withoutQuery.replaceAll("\\", "/").replace(/\/+$/, "");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function isLocalArtifactHref(href: string): boolean {
  return !/^(?:https?:|mailto:|tel:)/i.test(href.trim());
}

export function linkedPdfArtifact(
  href: string | undefined,
  label: string,
  artifacts: readonly ChatArtifact[],
): ChatArtifact | undefined {
  const localHref = href?.trim() ?? "";
  if (localHref && !isLocalArtifactHref(localHref)) return undefined;

  const candidates = [decodedBasename(localHref), label.trim()]
    .filter(Boolean)
    .map((value) => value.toLocaleLowerCase());

  return artifacts.find((artifact) =>
    artifact.contentType === "application/pdf"
    && candidates.includes(artifact.name.toLocaleLowerCase()));
}
