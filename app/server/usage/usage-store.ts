import "server-only";

import type { UsagePricing, UsageRecord, UsageRecordInput } from "../../../lib/usage-protocol";
import { calculateUsageCost, normalizeUsage } from "../../../lib/usage-pricing";
import { DEFAULT_DEEPSEEK_USAGE_PRICING } from "../../providers/deepseek/deepseek-pricing";
import { getServerClient } from "../../auth/supabase-server-adapter";

const table = () => getServerClient();

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pricingFromRow(row: Record<string, unknown>): UsagePricing {
  return {
    provider: String(row.provider),
    model: String(row.model),
    label: String(row.label),
    inputUsdPerMillion: numberValue(row.input_usd_per_million),
    cachedInputUsdPerMillion: row.cached_input_usd_per_million === null
      ? null
      : numberValue(row.cached_input_usd_per_million),
    outputUsdPerMillion: numberValue(row.output_usd_per_million),
  };
}

export async function listUsagePricing(): Promise<UsagePricing[]> {
  const { data, error } = await table()
    .from("chat_model_pricing")
    .select("provider,model,label,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million")
    .order("provider")
    .order("model");
  if (error) throw error;
  return (data ?? []).map((row) => pricingFromRow(row as Record<string, unknown>));
}

function usageColumns(input: UsageRecordInput) {
  const usage = normalizeUsage(input.usage);
  return {
    prompt_tokens: usage.promptTokens ?? 0,
    completion_tokens: usage.completionTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    cached_prompt_tokens: usage.cachedPromptTokens ?? 0,
    reasoning_tokens: usage.reasoningTokens ?? 0,
    usage_source: input.source,
    recorded_at: input.recordedAt ?? new Date().toISOString(),
  };
}

export async function queueUsage(input: UsageRecordInput): Promise<void> {
  const { error } = await table().from("chat_usage_outbox").upsert({
    owner_id: input.ownerId,
    provider: input.provider,
    model: input.model,
    request_kind: input.requestKind,
    request_id: input.requestId,
    round: input.round,
    ...usageColumns(input),
  }, {
    onConflict: "owner_id,provider,request_kind,request_id,round",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

async function writeUsageRecord(input: UsageRecordInput): Promise<void> {
  const catalog = await listUsagePricing();
  const pricing = catalog.find((entry) => entry.provider === input.provider && entry.model === input.model)
    ?? DEFAULT_DEEPSEEK_USAGE_PRICING.find((entry) => entry.provider === input.provider && entry.model === input.model)
    ?? null;
  const usage = normalizeUsage(input.usage);
  const costUsd = calculateUsageCost(usage, pricing);
  const { error } = await table().from("chat_usage_records").upsert({
    owner_id: input.ownerId,
    provider: input.provider,
    model: input.model,
    request_kind: input.requestKind,
    request_id: input.requestId,
    round: input.round,
    ...(input.recordedAt ? { recorded_at: input.recordedAt } : {}),
    prompt_tokens: usage.promptTokens ?? 0,
    completion_tokens: usage.completionTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    cached_prompt_tokens: usage.cachedPromptTokens ?? 0,
    reasoning_tokens: usage.reasoningTokens ?? 0,
    cost_usd: costUsd,
    usage_source: input.source,
    input_usd_per_million: pricing?.inputUsdPerMillion ?? null,
    cached_input_usd_per_million: pricing?.cachedInputUsdPerMillion ?? null,
    output_usd_per_million: pricing?.outputUsdPerMillion ?? null,
    pricing_label: pricing?.label ?? null,
  }, {
    onConflict: "owner_id,provider,request_kind,request_id,round",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

export async function flushUsageOutbox(ownerId: string): Promise<void> {
  while (true) {
    const { data, error } = await table()
      .from("chat_usage_outbox")
      .select("id,provider,model,request_kind,request_id,round,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens,usage_source,recorded_at")
      .eq("owner_id", ownerId)
      .order("id")
      .limit(100);
    if (error) throw error;
    if (!data?.length) return;
    let deleted = 0;
    for (const row of data) {
    const value = row as Record<string, unknown>;
    const input: UsageRecordInput = {
      ownerId,
      provider: String(value.provider),
      model: String(value.model),
      requestKind: value.request_kind as UsageRecordInput["requestKind"],
      requestId: String(value.request_id),
      round: numberValue(value.round),
      usage: {
        promptTokens: numberValue(value.prompt_tokens),
        completionTokens: numberValue(value.completion_tokens),
        totalTokens: numberValue(value.total_tokens),
        cachedPromptTokens: numberValue(value.cached_prompt_tokens),
        reasoningTokens: numberValue(value.reasoning_tokens),
      },
      source: value.usage_source as UsageRecordInput["source"],
      recordedAt: String(value.recorded_at),
    };
    try {
      await writeUsageRecord(input);
      const { error: deleteError } = await table().from("chat_usage_outbox").delete().eq("owner_id", ownerId).eq("id", value.id);
      if (deleteError) throw deleteError;
      deleted += 1;
    } catch {
      // Leave the row queued for the next usage report or request.
    }
    if (!deleted) return;
    }
  }
}

export async function recordUsage(input: UsageRecordInput): Promise<void> {
  await queueUsage(input);
  await flushUsageOutbox(input.ownerId).catch(() => undefined);
}

export async function listUsageRecords(
  ownerId: string,
  window?: { start: string; end: string },
): Promise<UsageRecord[]> {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    let query = table()
      .from("chat_usage_records")
      .select("provider,model,request_kind,request_id,round,recorded_at,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens,cost_usd,usage_source,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million,pricing_label")
      .eq("owner_id", ownerId)
      .order("recorded_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (window) query = query.gte("recorded_at", window.start).lt("recorded_at", window.end);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map((row) => {
    const value = row as Record<string, unknown>;
    const pricing = value.input_usd_per_million === null || value.output_usd_per_million === null
      ? null
      : {
          provider: String(value.provider),
          model: String(value.model),
          label: String(value.pricing_label ?? value.model),
          inputUsdPerMillion: numberValue(value.input_usd_per_million),
          cachedInputUsdPerMillion: value.cached_input_usd_per_million === null
            ? null
            : numberValue(value.cached_input_usd_per_million),
          outputUsdPerMillion: numberValue(value.output_usd_per_million),
        } satisfies UsagePricing;
    return {
      provider: String(value.provider),
      model: String(value.model),
      requestKind: value.request_kind as UsageRecord["requestKind"],
      requestId: String(value.request_id),
      round: numberValue(value.round),
      recordedAt: String(value.recorded_at),
      promptTokens: numberValue(value.prompt_tokens),
      completionTokens: numberValue(value.completion_tokens),
      totalTokens: numberValue(value.total_tokens),
      cachedPromptTokens: numberValue(value.cached_prompt_tokens),
      reasoningTokens: numberValue(value.reasoning_tokens),
      costUsd: value.cost_usd === null ? null : numberValue(value.cost_usd),
      source: value.usage_source as UsageRecord["source"],
      pricing,
    } satisfies UsageRecord;
  });
}
