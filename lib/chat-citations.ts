export type ChatSource = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publisher: string;
  publishedAt?: string;
};

export type ChatCitation = {
  start: number;
  end: number;
  sourceIds: string[];
};

export const CITATION_MARKER_PATTERN = /⟦cite:([^⟧]+)⟧/g;

export function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function stableSourceId(url: string): string {
  let hash = 2166136261;
  for (const character of canonicalSourceUrl(url)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `src_${(hash >>> 0).toString(16).padStart(8, "0")}${canonicalSourceUrl(url).length.toString(16).padStart(8, "0").slice(-8)}`;
}

export function publisherForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Web source";
  }
}

export function sourceForUrl(input: { title?: string; url: string; snippet?: string; publishedAt?: string }): ChatSource {
  return {
    id: stableSourceId(input.url),
    title: input.title?.trim() || input.url,
    url: canonicalSourceUrl(input.url),
    snippet: input.snippet?.trim() || "",
    publisher: publisherForUrl(input.url),
    ...(input.publishedAt?.trim() ? { publishedAt: input.publishedAt.trim() } : {}),
  };
}

export function parseCitationMarkup(markdown: string, sources: readonly ChatSource[]): { content: string; annotations: ChatCitation[] } {
  const sourceIds = new Set(sources.map((source) => source.id));
  let content = "";
  let cursor = 0;
  const annotations: ChatCitation[] = [];
  for (const match of markdown.matchAll(CITATION_MARKER_PATTERN)) {
    content += markdown.slice(cursor, match.index);
    const ids = [...new Set(match[1].split(",").map((id) => id.trim()).filter((id) => sourceIds.has(id)))];
    if (ids.length) {
      const end = content.length;
      const boundaries = [...content.matchAll(/[.!?]\s+|\n+/g)];
      const claimStart = boundaries.at(-1)?.index !== undefined
        ? (boundaries.at(-1)!.index! + boundaries.at(-1)![0].length)
        : 0;
      const previous = annotations.at(-1);
      if (previous && previous.end === end) previous.sourceIds = [...new Set([...previous.sourceIds, ...ids])];
      else annotations.push({ start: claimStart, end, sourceIds: ids });
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  content += markdown.slice(cursor);
  return { content, annotations };
}

export function validCitationSources(sources: readonly ChatSource[]): ChatSource[] {
  return sources.filter((source) => source.id && /^src_[a-f0-9]{16}$/.test(source.id) && /^https?:\/\//i.test(source.url));
}
