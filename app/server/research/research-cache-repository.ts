import "server-only";
import { getServerClient } from "../../auth/supabase-server-adapter";
import type { ResearchLink } from "./research-types";

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
  const { data, error } = await getServerClient().from("research_page_cache").select("*").eq("canonical_url", canonicalUrl).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    canonicalUrl: data.canonical_url as string,
    finalUrl: data.final_url as string,
    contentHash: data.content_hash as string,
    contentType: data.content_type as string,
    title: data.title as string,
    markdown: data.markdown as string,
    links: Array.isArray(data.links) ? data.links as ResearchLink[] : [],
    ...(typeof data.published_at === "string" ? { publishedAt: data.published_at } : {}),
    ...(typeof data.etag === "string" ? { etag: data.etag } : {}),
    ...(typeof data.last_modified === "string" ? { lastModified: data.last_modified } : {}),
    extractor: data.extractor as string,
    expiresAt: data.expires_at as string,
  };
}

export async function saveResearchPageCache(page: CachedResearchPage): Promise<void> {
  const { error } = await getServerClient().from("research_page_cache").upsert({
    canonical_url: page.canonicalUrl,
    final_url: page.finalUrl,
    content_hash: page.contentHash,
    content_type: page.contentType,
    title: page.title,
    markdown: page.markdown,
    links: page.links,
    published_at: page.publishedAt ?? null,
    etag: page.etag ?? null,
    last_modified: page.lastModified ?? null,
    extractor: page.extractor,
    expires_at: page.expiresAt,
    fetched_at: new Date().toISOString(),
  });
  if (error) throw error;
}
