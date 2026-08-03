import "server-only";

import type { ChatDocumentPage } from "../../../lib/chat-document";
import { ChatDocumentError } from "../../../lib/chat-document";
import { DOCUMENT_INGESTION_STAGES, type DocumentIngestionTiming } from "../../server/chat/document-ingestion-timing";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_FREE_MODEL,
  OPENROUTER_QUOTA_FALLBACK_MODEL,
  shouldUseOpenRouterQuotaFallback,
} from "./openrouter-config";

export async function parsePdfWithOpenRouter(bytes: Uint8Array, filename: string, signal?: AbortSignal, timing?: DocumentIngestionTiming): Promise<ChatDocumentPage[]> {
 const parse = async (): Promise<ChatDocumentPage[]> => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new ChatDocumentError("parser_unavailable", "The PDF parser is not configured.", 503);
  let response: Response | undefined;
  const fileData = `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
  for (const model of [OPENROUTER_FREE_MODEL, OPENROUTER_QUOTA_FALLBACK_MODEL]) {
   try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [
          { type: "file", file: { filename, file_data: fileData } },
          { type: "text", text: "Return the extracted PDF verbatim as JSON only: {\"pages\":[{\"pageNumber\":1,\"text\":\"...\"}]}. Preserve every page and do not summarize." },
        ] }],
        plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
      }),
    });
   } catch {
    if (signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The free PDF parser request was cancelled.", 499);
    throw new ChatDocumentError("parser_unavailable", "The PDF parser is unavailable.", 502);
   }
   if (response.ok) break;
   await response.text().catch(() => "");
   if (shouldUseOpenRouterQuotaFallback(response.status, model)) continue;
   throw new ChatDocumentError("parser_unavailable", `The PDF parser is unavailable (${response.status}).`, 502);
  }
  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  if (!response || !response.ok) throw new ChatDocumentError("parser_unavailable", "The PDF parser is unavailable.", 502);
  try {
    body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  } catch {
    throw new ChatDocumentError("parser_failed", "The PDF parser returned an invalid response.", 502);
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ChatDocumentError("parser_failed", "The PDF parser returned no extracted text.", 502);
  try {
    const clean = content.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(clean) as { pages?: Array<{ pageNumber?: unknown; text?: unknown }> };
    if (!Array.isArray(parsed.pages) || !parsed.pages.length) throw new Error();
    return parsed.pages.map((page, index) => ({ pageNumber: index + 1, text: typeof page.text === "string" ? page.text : "", extractionMethod: typeof page.text === "string" && page.text.trim() ? "native" : "blank" }));
  } catch { throw new ChatDocumentError("parser_failed", "The PDF parser returned invalid page data.", 502); }
 };
 return timing ? timing.measure(DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, parse) : parse();
}
