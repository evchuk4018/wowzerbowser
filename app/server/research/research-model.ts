import "server-only";
import { completeOpenRouterQwenText } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import type { ResearchClaim } from "../../../lib/chat-protocol";
import type { ResearchQuery } from "./research-types";

type Answer = Awaited<ReturnType<typeof completeOpenRouterQwenText>>;
const json = (content: string): Record<string, unknown> => {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(cleaned);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research model returned invalid JSON.");
  return value as Record<string, unknown>;
};
const strings = (value: unknown, maximum = 20): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, maximum) : [];

export async function decomposeResearchRequest(request: string, maximum: number, signal: AbortSignal | undefined, onAnswer: (answer: Answer) => Promise<void>): Promise<ResearchQuery[]> {
  const answer = await completeOpenRouterQwenText(request.slice(0, 20_000), {
    signal,
    timeoutMs: 20_000,
    maxTokens: 900,
    systemPrompt: `Return strict JSON {"queries":[{"query":"...","intent":"official|recent|analysis|community|contradicting|academic|developer","freshness":"day|week|month|year"}]}. Create ${Math.min(5, maximum)} to ${maximum} targeted queries. Collectively cover primary/official sources, recent information, independent analysis, community anecdotes, and contradicting evidence. Use academic or developer intents when relevant. No markdown.`,
  });
  await onAnswer(answer);
  const queries = Array.isArray(json(answer.content).queries) ? json(answer.content).queries as unknown[] : [];
  return queries.map((value) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const intent = ["official", "recent", "analysis", "community", "contradicting", "academic", "developer"].includes(String(item.intent)) ? item.intent as ResearchQuery["intent"] : "analysis";
    const fresh = ["day", "week", "month", "year"].includes(String(item.freshness)) ? item.freshness as ResearchQuery["freshness"] : undefined;
    return typeof item.query === "string" && item.query.trim() ? { query: item.query.trim().slice(0, 400), intent, ...(fresh ? { freshness: fresh } : {}) } : null;
  }).filter((item): item is ResearchQuery => Boolean(item)).slice(0, maximum);
}

export async function extractResearchClaims(request: string, evidence: string, signal: AbortSignal | undefined, onAnswer: (answer: Answer) => Promise<void>): Promise<ResearchClaim[]> {
  const answer = await completeOpenRouterQwenText(`<request>${request}</request>\n<evidence>${evidence}</evidence>`, {
    signal,
    timeoutMs: 25_000,
    maxTokens: 2_500,
    systemPrompt: 'Extract only material claims supported by the evidence. Return strict JSON {"claims":[{"id":"claim-1","claim":"...","supportingSourceIds":["src_..."],"conflictingSourceIds":[],"dates":[],"confidence":"high|medium|low","status":"supported|weak|conflicting|outdated"}]}. Preserve exact source ids. Identify conflicts instead of merging them away. No markdown.',
  });
  await onAnswer(answer);
  return normalizeClaims(json(answer.content).claims);
}

export async function verifyResearchClaims(request: string, claims: ResearchClaim[], evidence: string, signal: AbortSignal | undefined, onAnswer: (answer: Answer) => Promise<void>): Promise<{ claims: ResearchClaim[]; followUpQueries: ResearchQuery[] }> {
  const answer = await completeOpenRouterQwenText(`<request>${request}</request>\n<claims>${JSON.stringify(claims)}</claims>\n<evidence>${evidence}</evidence>`, {
    signal,
    timeoutMs: 25_000,
    maxTokens: 2_500,
    systemPrompt: 'Verify every claim against the evidence. Downgrade unsupported or outdated claims and expose conflicts. Return strict JSON {"claims":[same schema],"followUpQueries":[{"query":"...","intent":"official|recent|analysis|community|contradicting|academic|developer"}]}. Return at most two follow-up queries only for consequential gaps or conflicts. Preserve exact source ids. No markdown.',
  });
  await onAnswer(answer);
  const parsed = json(answer.content);
  const followUps = Array.isArray(parsed.followUpQueries) ? parsed.followUpQueries : [];
  return {
    claims: normalizeClaims(parsed.claims),
    followUpQueries: followUps.map((value) => {
      const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const intent = ["official", "recent", "analysis", "community", "contradicting", "academic", "developer"].includes(String(item.intent)) ? item.intent as ResearchQuery["intent"] : "contradicting";
      return typeof item.query === "string" && item.query.trim() ? { query: item.query.trim().slice(0, 400), intent } : null;
    }).filter((item): item is ResearchQuery => Boolean(item)).slice(0, 2),
  };
}

function normalizeClaims(value: unknown): ResearchClaim[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const claim = typeof item.claim === "string" ? item.claim.trim().slice(0, 2_000) : "";
    if (!claim) return null;
    const confidence = ["high", "medium", "low"].includes(String(item.confidence)) ? item.confidence as ResearchClaim["confidence"] : "low";
    const status = ["supported", "weak", "conflicting", "outdated"].includes(String(item.status)) ? item.status as ResearchClaim["status"] : "weak";
    return { id: typeof item.id === "string" ? item.id.slice(0, 64) : `claim-${index + 1}`, claim, supportingSourceIds: strings(item.supportingSourceIds), conflictingSourceIds: strings(item.conflictingSourceIds), dates: strings(item.dates, 10), confidence, status };
  }).filter((item): item is ResearchClaim => Boolean(item)).slice(0, 50);
}

