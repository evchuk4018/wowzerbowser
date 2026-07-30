import "server-only";
import { canonicalSourceUrl, sourceForUrl } from "../../../lib/chat-citations";
import { extractBrowser, extractDirect, extractExa, extractJina, ResearchNotModifiedError, type ExtractedPage } from "../../providers/research/research-page-adapters";
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
    source: sourceForUrl({ title: extracted.title, url: extracted.finalUrl, snippet: extracted.markdown.slice(0, 1_200), publishedAt: extracted.publishedAt }),
    markdown: extracted.markdown,
    links: extracted.links.map((link, index) => ({ ...link, id: linkId(id, index) })),
    extractor: extracted.extractor,
    contentHash: extracted.contentHash,
    contentType: extracted.contentType,
  };
}

export async function fetchResearchPage(url: string, request: string, options: { allowExa: boolean; allowBrowser: boolean }): Promise<{ page: FetchedResearchPage; paidProvider?: "exa" | "browser" }> {
  const canonical = canonicalSourceUrl(url);
  const cached = await readResearchPageCache(canonical).catch(() => null);
  if (cached && Date.parse(cached.expiresAt) > Date.now()) {
    return { page: materialize({ finalUrl: cached.finalUrl, title: cached.title, markdown: cached.markdown, links: cached.links, contentType: cached.contentType, extractor: `cache:${cached.extractor}`, contentHash: cached.contentHash, publishedAt: cached.publishedAt }) };
  }
  const attempts: Array<{ provider?: "exa" | "browser"; run: () => Promise<ExtractedPage> }> = [
    { run: () => extractDirect(url, request, { etag: cached?.etag, lastModified: cached?.lastModified }) },
    { run: () => extractJina(url) },
    ...(options.allowExa ? [{ provider: "exa" as const, run: () => extractExa(url) }] : []),
    ...(options.allowBrowser ? [{ provider: "browser" as const, run: () => extractBrowser(url) }] : []),
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const extracted = await attempt.run();
      await saveResearchPageCache({
        canonicalUrl: canonical,
        finalUrl: extracted.finalUrl,
        contentHash: extracted.contentHash,
        contentType: extracted.contentType,
        title: extracted.title,
        markdown: extracted.markdown,
        links: extracted.links,
        publishedAt: extracted.publishedAt,
        etag: extracted.etag,
        lastModified: extracted.lastModified,
        extractor: extracted.extractor,
        expiresAt: expiry(extracted.contentType, extracted.publishedAt),
      }).catch(() => undefined);
      return { page: materialize(extracted), ...(attempt.provider ? { paidProvider: attempt.provider } : {}) };
    } catch (error) {
      if (error instanceof ResearchNotModifiedError && cached) {
        const refreshed = { ...cached, expiresAt: expiry(cached.contentType, cached.publishedAt) };
        await saveResearchPageCache(refreshed).catch(() => undefined);
        return { page: materialize({ finalUrl: refreshed.finalUrl, title: refreshed.title, markdown: refreshed.markdown, links: refreshed.links, contentType: refreshed.contentType, extractor: `cache-revalidated:${refreshed.extractor}`, contentHash: refreshed.contentHash, publishedAt: refreshed.publishedAt }) };
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Page extraction failed.");
}
