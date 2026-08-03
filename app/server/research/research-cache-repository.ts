import "server-only";
import type { ResearchLink } from "./research-types";
import { isoTimestamp, jsonb, query } from "../database/database";

export type CachedResearchPage = {
  canonicalUrl: string;
  finalUrl: string;
  contentHash: string;
  contentType: string;
  title: string;
  markdown: string;
  links: ResearchLink[];
  publishedAt?: string;
  etag?: string;
  lastModified?: string;
  extractor: string;
  expiresAt: string;
};

export async function readResearchPageCache(canonicalUrl: string): Promise<CachedResearchPage | null> {
  const [data] = await query<Record<string, unknown>>("select * from research_page_cache where canonical_url=$1", [canonicalUrl]);
  if (!data) return null;
  return {
    canonicalUrl: data.canonical_url as string,
    finalUrl: data.final_url as string,
    contentHash: data.content_hash as string,
    contentType: data.content_type as string,
    title: data.title as string,
    markdown: data.markdown as string,
    links: Array.isArray(data.links) ? data.links as ResearchLink[] : [],
    ...(data.published_at != null ? { publishedAt: isoTimestamp(data.published_at) } : {}),
    ...(typeof data.etag === "string" ? { etag: data.etag } : {}),
    ...(typeof data.last_modified === "string" ? { lastModified: data.last_modified } : {}),
    extractor: data.extractor as string,
    expiresAt: isoTimestamp(data.expires_at),
  };
}

export async function saveResearchPageCache(page: CachedResearchPage): Promise<void> {
  await query(`insert into research_page_cache(canonical_url,final_url,content_hash,content_type,title,markdown,links,published_at,etag,last_modified,extractor,expires_at,fetched_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
    on conflict(canonical_url) do update set final_url=excluded.final_url,content_hash=excluded.content_hash,content_type=excluded.content_type,title=excluded.title,markdown=excluded.markdown,links=excluded.links,published_at=excluded.published_at,etag=excluded.etag,last_modified=excluded.last_modified,extractor=excluded.extractor,expires_at=excluded.expires_at,fetched_at=excluded.fetched_at`,
    [page.canonicalUrl, page.finalUrl, page.contentHash, page.contentType, page.title, page.markdown, jsonb(page.links), page.publishedAt ?? null, page.etag ?? null, page.lastModified ?? null, page.extractor, page.expiresAt, new Date().toISOString()]);
}
