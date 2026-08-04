import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { ResearchLink } from "../../server/research/research-types";
import { record, searchRequest, text } from "../search/search-http";

const TIMEOUT_MS = 30_000;
const MAX_MARKDOWN = 80_000;

export type ExtractedPage = {
  finalUrl: string;
  title: string;
  markdown: string;
  links: ResearchLink[];
  contentType: string;
  extractor: string;
  publishedAt?: string;
  contentHash: string;
};

function privateIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.");
}

export async function assertPublicResearchUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Research navigation requires a public HTTP(S) URL.");
  if (url.hostname === "localhost" || isIP(url.hostname) && privateIp(url.hostname)) throw new Error("Private research URLs are not allowed.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => privateIp(item.address))) throw new Error("Private research URLs are not allowed.");
  return url;
}

function hash(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function linksFromMarkdown(markdown: string): ResearchLink[] {
  const links: ResearchLink[] = [];
  const seen = new Set<string>();
  const pattern = /\[([^\]]{1,300})\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const url = match[2];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, text: match[1].replace(/\s+/g, " ").trim() });
    if (links.length >= 300) break;
  }
  return links;
}

async function directHtmlExtraction(url: string, signal?: AbortSignal): Promise<ExtractedPage> {
  let current = await assertPublicResearchUrl(url);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await searchRequest(current.toString(), {
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "User-Agent": "wowzerbowser-research/1.0" },
    }, signal, TIMEOUT_MS);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 4) throw new Error("Page redirect limit exceeded.");
      current = await assertPublicResearchUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Direct page request failed with status ${response.status}.`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("html") && !contentType.includes("text/plain")) throw new Error("Unsupported page content type.");
    const html = (await response.text()).slice(0, MAX_MARKDOWN * 8);
    const dom = new JSDOM(html, { url: current.toString() });
    const parsed = new Readability(dom.window.document.cloneNode(true) as Document).parse();
    const markdown = (parsed?.textContent ?? dom.window.document.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").replace(/\s+\n/g, "\n").trim().slice(0, MAX_MARKDOWN);
    if (markdown.length < 200) throw new Error("Direct extraction returned too little content.");
    const links = [...dom.window.document.querySelectorAll("a[href]")].flatMap((element) => {
      try { return [{ url: new URL(element.getAttribute("href")!, current).toString(), text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) }]; } catch { return []; }
    }).filter((link) => /^https?:\/\//i.test(link.url)).slice(0, 300);
    return {
      finalUrl: current.toString(),
      title: (parsed?.title ?? dom.window.document.title ?? current.toString()).trim().slice(0, 300),
      markdown,
      links,
      contentType: contentType || "text/html",
      extractor: "direct-readability-fallback",
      contentHash: hash(markdown),
    };
  }
  throw new Error("Page redirect limit exceeded.");
}

export async function extractFirecrawl(url: string, signal?: AbortSignal): Promise<ExtractedPage> {
  await assertPublicResearchUrl(url);
  const base = process.env.FIRECRAWL_URL?.trim() || "http://firecrawl:3002";
  const endpoint = new URL("/v2/scrape", `${base.replace(/\/$/, "")}/`);
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  try {
    const response = await searchRequest(endpoint.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, blockAds: true, removeBase64Images: true }),
    }, signal, TIMEOUT_MS);
    if (!response.ok) throw new Error(`Firecrawl page retrieval failed with status ${response.status}.`);
    const body = record(await response.json());
    const data = record(body.data);
    const metadata = record(data.metadata);
    const markdown = text(data.markdown ?? data.content, MAX_MARKDOWN);
    if (markdown.length < 200) throw new Error("Firecrawl returned too little content.");
    const finalUrl = text(metadata.sourceURL ?? metadata.sourceUrl, 2_000) || url;
    return { finalUrl, title: text(metadata.title, 300) || finalUrl, markdown, links: linksFromMarkdown(markdown), contentType: "text/markdown", extractor: "firecrawl", ...(text(metadata.publishedTime ?? metadata.publishedAt, 100) ? { publishedAt: text(metadata.publishedTime ?? metadata.publishedAt, 100) } : {}), contentHash: hash(markdown) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return directHtmlExtraction(url, signal);
  }
}
