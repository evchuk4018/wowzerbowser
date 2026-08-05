import "server-only";

import type { UsagePricing, UsageRecord, UsageRecordInput } from "../../../lib/usage-protocol";
import { calculateUsageCost, normalizeUsage } from "../../../lib/usage-pricing";
import { DEFAULT_DEEPSEEK_USAGE_PRICING } from "../../providers/deepseek/deepseek-pricing";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";

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
  const rows = await query<Record<string, unknown>>("select provider,model,label,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million from chat_model_pricing order by provider,model");
  return rows.map((row) => pricingFromRow(row));
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
    conversation_id: input.conversationId ?? null,
    job_id: input.jobId ?? null,
    exact_cost_usd: input.exactCostUsd ?? null,
    pricing_snapshot: input.pricingSnapshot ?? null,
    unpriced: input.unpriced ?? false,
  };
}

export async function queueUsage(input: UsageRecordInput): Promise<void> {
  const values = usageColumns(input);
  await query(`insert into chat_usage_outbox(owner_id,provider,model,request_kind,request_id,round,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens,usage_source,recorded_at,conversation_id,job_id,exact_cost_usd,pricing_snapshot,unpriced)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
    on conflict(owner_id,provider,request_kind,request_id,round) do nothing`,
    [databaseOwnerId(input.ownerId), input.provider, input.model, input.requestKind, input.requestId, input.round, values.prompt_tokens, values.completion_tokens, values.total_tokens, values.cached_prompt_tokens, values.reasoning_tokens, values.usage_source, values.recorded_at, values.conversation_id, values.job_id, values.exact_cost_usd, values.pricing_snapshot == null ? null : jsonb(values.pricing_snapshot), values.unpriced]);
}

async function writeUsageRecord(input: UsageRecordInput): Promise<void> {
  const catalog = await listUsagePricing();
  const pricing = catalog.find((entry) => entry.provider === input.provider && entry.model === input.model)
    ?? DEFAULT_DEEPSEEK_USAGE_PRICING.find((entry) => entry.provider === input.provider && entry.model === input.model)
    ?? null;
  const usage = normalizeUsage(input.usage);
  const effectivePricing = input.pricingSnapshot ?? pricing;
  const costUsd = input.exactCostUsd ?? calculateUsageCost(usage, effectivePricing);
  await query(`insert into chat_usage_records(owner_id,provider,model,request_kind,request_id,round,recorded_at,conversation_id,job_id,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens,cost_usd,usage_source,exact_cost_usd,pricing_snapshot,unpriced,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million,pricing_label)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23)
    on conflict(owner_id,provider,request_kind,request_id,round) do nothing`,
    [databaseOwnerId(input.ownerId), input.provider, input.model, input.requestKind, input.requestId, input.round, input.recordedAt ?? new Date().toISOString(), input.conversationId ?? null, input.jobId ?? null, usage.promptTokens ?? 0, usage.completionTokens ?? 0, usage.totalTokens ?? 0, usage.cachedPromptTokens ?? 0, usage.reasoningTokens ?? 0, costUsd, input.source, input.exactCostUsd ?? null, effectivePricing == null ? null : jsonb(effectivePricing), input.unpriced ?? (costUsd === null), effectivePricing?.inputUsdPerMillion ?? null, effectivePricing?.cachedInputUsdPerMillion ?? null, effectivePricing?.outputUsdPerMillion ?? null, effectivePricing?.label ?? null]);
}

export async function flushUsageOutbox(ownerId: string): Promise<void> {
  const databaseOwner = databaseOwnerId(ownerId);
  while (true) {
    const data = await query<Record<string, unknown>>("select id,provider,model,request_kind,request_id,round,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens,usage_source,recorded_at,conversation_id,job_id,exact_cost_usd,pricing_snapshot,unpriced from chat_usage_outbox where owner_id=$1 order by id limit 100", [databaseOwner]);
    if (!data.length) return;
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
      recordedAt: isoTimestamp(value.recorded_at),
      conversationId: typeof value.conversation_id === "string" ? value.conversation_id : undefined,
      jobId: typeof value.job_id === "string" ? value.job_id : undefined,
      exactCostUsd: value.exact_cost_usd === null ? null : numberValue(value.exact_cost_usd),
      pricingSnapshot: value.pricing_snapshot && typeof value.pricing_snapshot === "object" ? value.pricing_snapshot as UsagePricing : null,
      unpriced: value.unpriced === true,
    };
    try {
      await writeUsageRecord(input);
      await query("delete from chat_usage_outbox where owner_id=$1 and id=$2", [databaseOwner, value.id]);
      deleted += 1;
    } catch (error) {
      console.warn("usage-outbox-flush-failed", {
        ownerId,
        outboxId: String(value.id),
        provider: input.provider,
        model: input.model,
        requestKind: input.requestKind,
        error: error instanceof Error ? error.message : String(error),
      });
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
  const databaseOwner = databaseOwnerId(ownerId);
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const parameters: unknown[] = [databaseOwner];
    let statement = "select provider,model,request_kind,request_id,round,recorded_at,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens,cost_usd,usage_source,input_usd_per_million,cached_input_usd_per_million,output_usd_per_million,pricing_label from chat_usage_records where owner_id=$1";
    if (window) {
      parameters.push(window.start, window.end);
      statement += " and recorded_at >= $2 and recorded_at < $3";
    }
    parameters.push(pageSize, offset);
    statement += ` order by recorded_at asc limit $${parameters.length - 1} offset $${parameters.length}`;
    const page = await query<Record<string, unknown>>(statement, parameters);
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
      recordedAt: isoTimestamp(value.recorded_at),
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
