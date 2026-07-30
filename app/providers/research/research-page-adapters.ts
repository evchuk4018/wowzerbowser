import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { configuredKeys, withProviderKeys } from "../../server/agent/web-api-key-pool";
import { parsePdfNatively } from "../../server/chat/pdf-native-parser";
import { renderPdfPagesSettled } from "../../server/chat/pdf-page-renderer";
import type { ResearchLink } from "../../server/research/research-types";

const TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_MARKDOWN = 80_000;
const MAX_REDIRECTS = 4;

export type ExtractedPage = {
  finalUrl: string;
  title: string;
  markdown: string;
  links: ResearchLink[];
  contentType: string;
  extractor: string;
  etag?: string;
  lastModified?: string;
  publishedAt?: string;
  contentHash: string;
};

export class ResearchNotModifiedError extends Error {}

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

async function publicFetch(value: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicResearchUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "wowzerbowser-research/1.0", ...(init.headers ?? {}) } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) throw new Error("Page redirect limit exceeded.");
    url = await assertPublicResearchUrl(new URL(location, url).toString());
  }
  throw new Error("Page redirect limit exceeded.");
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("Page exceeds the extraction size limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("Page exceeds the extraction size limit.");
  return bytes;
}

function hash(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function htmlPage(html: string, finalUrl: string, response: Response): ExtractedPage {
  const dom = new JSDOM(html, { url: finalUrl });
  const links = [...dom.window.document.querySelectorAll("a[href]")].flatMap((element) => {
    try {
      return [{
        url: new URL(element.getAttribute("href")!, finalUrl).toString(),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      }];
    } catch {
      return [];
    }
  }).filter((item) => /^https?:\/\//i.test(item.url)).slice(0, 300);
  const parsed = new Readability(dom.window.document.cloneNode(true) as Document).parse();
  const markdown = (parsed?.textContent ?? dom.window.document.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_MARKDOWN);
  if (markdown.length < 200) throw new Error("Local Readability extraction returned too little content.");
  const publishedAt = dom.window.document.querySelector('meta[property="article:published_time"],meta[name="date"]')?.getAttribute("content") ?? undefined;
  return {
    finalUrl,
    title: (parsed?.title ?? dom.window.document.title ?? finalUrl).trim().slice(0, 300),
    markdown,
    links,
    contentType: response.headers.get("content-type") ?? "text/html",
    extractor: "readability",
    ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
    ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    contentHash: hash(markdown),
  };
}

function relevance(text: string, request: string): number {
  const terms = new Set(request.toLowerCase().split(/\W+/).filter((item) => item.length > 3));
  return [...terms].reduce((score, term) => score + Number(text.toLowerCase().includes(term)), 0);
}

async function pdfPage(bytes: Uint8Array, finalUrl: string, request: string, response: Response): Promise<ExtractedPage> {
  const parsed = await parsePdfNatively(bytes);
  const pages = [...parsed.pages].sort((a, b) => relevance(b.text, request) - relevance(a.text, request));
  const selected = pages.slice(0, Math.min(12, pages.length));
  const figurePages = selected.filter((page) => page.imageObjectCount > 0 || /\b(?:figure|table|chart|diagram)\b/i.test(page.text)).slice(0, 4).map((page) => page.pageNumber);
  if (figurePages.length) await renderPdfPagesSettled(bytes, figurePages).catch(() => undefined);
  const markdown = selected.sort((a, b) => a.pageNumber - b.pageNumber).map((page) => `## Page ${page.pageNumber}\n\n${page.text}`).join("\n\n").slice(0, MAX_MARKDOWN);
  return {
    finalUrl,
    title: finalUrl.split("/").at(-1) || "PDF",
    markdown,
    links: [],
    contentType: "application/pdf",
    extractor: figurePages.length ? "pdfjs+selective-render" : "pdfjs",
    ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
    ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    contentHash: hash(markdown),
  };
}

export async function extractDirect(url: string, request: string, validators: { etag?: string; lastModified?: string } = {}): Promise<ExtractedPage> {
  const response = await publicFetch(url, { headers: {
    Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8",
    ...(validators.etag ? { "If-None-Match": validators.etag } : {}),
    ...(validators.lastModified ? { "If-Modified-Since": validators.lastModified } : {}),
  } });
  if (response.status === 304) throw new ResearchNotModifiedError();
  if (!response.ok) throw new Error(`Direct page request failed with ${response.status}.`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/pdf") || new URL(response.url || url).pathname.toLowerCase().endsWith(".pdf")) {
    return pdfPage(await boundedBytes(response, 25 * 1024 * 1024), response.url || url, request, response);
  }
  if (!contentType.includes("html") && !contentType.includes("text/plain") && contentType) throw new Error("Unsupported page content type.");
  const html = new TextDecoder().decode(await boundedBytes(response, MAX_HTML_BYTES));
  return htmlPage(html, response.url || url, response);
}

export async function extractJina(url: string): Promise<ExtractedPage> {
  await assertPublicResearchUrl(url);
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (process.env.JINA_API_KEY?.trim()) headers.Authorization = `Bearer ${process.env.JINA_API_KEY.trim()}`;
  const response = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error("Jina Reader extraction failed.");
  const markdown = (await response.text()).trim().slice(0, MAX_MARKDOWN);
  if (markdown.length < 200) throw new Error("Jina Reader returned too little content.");
  return { finalUrl: url, title: markdown.match(/^Title:\s*(.+)$/m)?.[1]?.slice(0, 300) ?? url, markdown, links: [], contentType: "text/markdown", extractor: "jina-reader", contentHash: hash(markdown) };
}

export async function extractExa(url: string): Promise<ExtractedPage> {
  await assertPublicResearchUrl(url);
  const response = await withProviderKeys(configuredKeys("exa"), (key) => fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ urls: [url], text: { maxCharacters: MAX_MARKDOWN } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error("Exa page extraction failed.");
  const row = ((await response.json()) as { results?: Array<{ text?: string; title?: string; publishedDate?: string }> }).results?.[0];
  const markdown = row?.text?.trim().slice(0, MAX_MARKDOWN) ?? "";
  if (markdown.length < 200) throw new Error("Exa returned too little content.");
  return { finalUrl: url, title: row?.title?.slice(0, 300) ?? url, markdown, links: [], contentType: "text/markdown", extractor: "exa", ...(row?.publishedDate ? { publishedAt: row.publishedDate } : {}), contentHash: hash(markdown) };
}

export async function extractBrowser(url: string): Promise<ExtractedPage> {
  await assertPublicResearchUrl(url);
  const base = process.env.BROWSER_RENDERER_URL?.trim();
  if (!base) throw new Error("Browser rendering is not configured.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.BROWSER_RENDERER_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.BROWSER_RENDERER_TOKEN.trim()}`;
  const response = await fetch(new URL("/content", base), {
    method: "POST",
    headers,
    body: JSON.stringify({ url, gotoOptions: { waitUntil: "networkidle2", timeout: TIMEOUT_MS } }),
    signal: AbortSignal.timeout(TIMEOUT_MS + 2_000),
  });
  if (!response.ok) throw new Error("Browser rendering failed.");
  const html = new TextDecoder().decode(await boundedBytes(response, MAX_HTML_BYTES));
  const page = htmlPage(html, url, response);
  return { ...page, extractor: "browser" };
}
