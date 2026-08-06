import "server-only";

import { JSDOM } from "jsdom";
import { CHAT_SOURCE_SNIPPET_MAX_LENGTH } from "../../../lib/chat-citations";
import type { SearchCandidate, SearchProviderQuery } from "../../server/search/search-types";
import { searchRequest, text } from "./search-http";
import { candidate } from "./search-candidate";

const POST_PATH = /\/r\/[^/]+\/comments\//i;

function publicRedditUrl(path: string): string {
  const base = process.env.REDLIB_PUBLIC_BASE_URL?.trim() || "https://www.reddit.com";
  return new URL(path, `${base.replace(/\/$/, "")}/`).toString();
}

function resultText(anchor: Element): string {
  const container = anchor.closest("article, .post, .thread, .result") ?? anchor.parentElement;
  return (container?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, CHAT_SOURCE_SNIPPET_MAX_LENGTH);
}

function requireSearchResponse(response: Response): void {
  if (!response.ok) {
    console.warn(`[search] redlib search endpoint returned status ${response.status}.`);
    throw new Error(`Redlib search failed with status ${response.status}.`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("html")) throw new Error("Redlib search returned an unexpected content type.");
}

export async function searchRedlib(query: SearchProviderQuery, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const base = process.env.REDLIB_URL?.trim() || "http://redlib:8080";
  const endpoint = new URL("/search", `${base.replace(/\/$/, "")}/`);
  endpoint.search = new URLSearchParams({ q: query.query, sort: "relevance" }).toString();
  const response = await searchRequest(endpoint.toString(), { headers: { Accept: "text/html" } }, signal);
  requireSearchResponse(response);
  const html = await response.text();
  const dom = new JSDOM(html, { url: endpoint.toString() });
  if (dom.window.document.querySelector("#error")) {
    console.warn("[search] redlib search returned an upstream error page.");
    throw new Error("Redlib search returned an upstream error page.");
  }
  const seen = new Set<string>();
  const results: SearchCandidate[] = [];
  for (const anchor of [...dom.window.document.querySelectorAll("a[href]")]) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    let parsed: URL;
    try { parsed = new URL(href, endpoint); } catch { continue; }
    if (!POST_PATH.test(parsed.pathname)) continue;
    const url = publicRedditUrl(`${parsed.pathname}${parsed.search}`);
    if (seen.has(url)) continue;
    seen.add(url);
    const title = text(anchor.textContent, 300);
    const item = candidate({
      title,
      url,
      snippet: resultText(anchor),
      provider: "redlib",
      query,
      rank: results.length + 1,
    });
    if (item) results.push(item);
    if (results.length >= query.count) break;
  }
  return results;
}
