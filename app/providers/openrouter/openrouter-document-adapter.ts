import "server-only";

import type { ChatDocumentPage } from "../../../lib/chat-document";
import { ChatDocumentError } from "../../../lib/chat-document";
import { DOCUMENT_INGESTION_STAGES, type DocumentIngestionTiming } from "../../server/chat/document-ingestion-timing";

export async function parsePdfWithOpenRouter(downloadUrl: string, filename: string, signal?: AbortSignal, timing?: DocumentIngestionTiming): Promise<ChatDocumentPage[]> {
 const parse = async (): Promise<ChatDocumentPage[]> => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new ChatDocumentError("parser_unavailable", "The free PDF parser is not configured.", 503);
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [{ role: "user", content: [
          { type: "file", file: { filename, file_data: downloadUrl } },
          { type: "text", text: "Return the extracted PDF verbatim as JSON only: {\"pages\":[{\"pageNumber\":1,\"text\":\"...\"}]}. Preserve every page and do not summarize." },
        ] }],
        plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
      }),
    });
  } catch {
    if (signal?.aborted) throw new ChatDocumentError("parser_cancelled", "The free PDF parser request was cancelled.", 499);
    throw new ChatDocumentError("parser_unavailable", "The free PDF parser is unavailable; no paid fallback was used.", 502);
  }
  if (!response.ok) throw new ChatDocumentError("parser_unavailable", `The free Cloudflare PDF parser is unavailable (${response.status}); no paid fallback was used.`, 502);
  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  } catch {
    throw new ChatDocumentError("parser_failed", "The free PDF parser returned an invalid response.", 502);
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ChatDocumentError("parser_failed", "The free PDF parser returned no extracted text.", 502);
  try {
    const clean = content.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(clean) as { pages?: Array<{ pageNumber?: unknown; text?: unknown }> };
    if (!Array.isArray(parsed.pages) || !parsed.pages.length) throw new Error();
    return parsed.pages.map((page, index) => ({ pageNumber: index + 1, text: typeof page.text === "string" ? page.text : "" }));
  } catch { throw new ChatDocumentError("parser_failed", "The free PDF parser returned invalid page data.", 502); }
 };
 return timing ? timing.measure(DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, parse) : parse();
}
