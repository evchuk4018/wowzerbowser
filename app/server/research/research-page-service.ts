import "server-only";
import { CHAT_SOURCE_SNIPPET_MAX_LENGTH, canonicalSourceUrl, sourceForUrl } from "../../../lib/chat-citations";
import { extractFirecrawl, type ExtractedPage } from "../../providers/research/research-page-adapters";
import { readResearchPageCache, saveResearchPageCache } from "./research-cache-repository";
import type { FetchedResearchPage } from "./research-types";

function expiry(contentType: string, publishedAt?: string): string {
  const news = publishedAt && Date.now() - Date.parse(publishedAt) < 30 * 86_400_000;
  const scholarly = /pdf|academic|doi/i.test(contentType);
  const days = news ? 1 : scholarly ? 30 : 7;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function pageId(hash: string): string { return `page_${hash.slice(0, 16)}`; }
function linkId(page: string, index: number): string { return `${page}_link_${index + 1}`; }

function materialize(extracted: ExtractedPage): FetchedResearchPage {
  const id = pageId(extracted.contentHash);
  return {
    id,
    source: sourceForUrl({ title: extracted.title, url: extracted.finalUrl, snippet: extracted.markdown.slice(0, CHAT_SOURCE_SNIPPET_MAX_LENGTH), publishedAt: extracted.publishedAt }),
    markdown: extracted.markdown,
    links: extracted.links.map((link, index) => ({ ...link, id: linkId(id, index) })),
    extractor: extracted.extractor,
    contentHash: extracted.contentHash,
    contentType: extracted.contentType,
  };
}

export async function fetchResearchPage(url: string, signal?: AbortSignal): Promise<{ page: FetchedResearchPage }> {
  const canonical = canonicalSourceUrl(url);
  const stored = await readResearchPageCache(canonical).catch(() => null);
  const cached = stored?.extractor.startsWith("firecrawl") ? stored : null;
  if (cached && Date.parse(cached.expiresAt) > Date.now()) {
    return { page: materialize({ finalUrl: cached.finalUrl, title: cached.title, markdown: cached.markdown, links: cached.links, contentType: cached.contentType, extractor: `cache:${cached.extractor}`, contentHash: cached.contentHash, publishedAt: cached.publishedAt }) };
  }
  const extracted: ExtractedPage = await extractFirecrawl(url, signal);
  await saveResearchPageCache({
    canonicalUrl: canonical,
    finalUrl: extracted.finalUrl,
    contentHash: extracted.contentHash,
    contentType: extracted.contentType,
    title: extracted.title,
    markdown: extracted.markdown,
    links: extracted.links,
    publishedAt: extracted.publishedAt,
    extractor: extracted.extractor,
    expiresAt: expiry(extracted.contentType, extracted.publishedAt),
  }).catch(() => undefined);
  return { page: materialize(extracted) };
}
