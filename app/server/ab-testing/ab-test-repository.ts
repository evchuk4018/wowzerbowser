import "server-only";

import { randomUUID } from "node:crypto";
import type { AbTestRequestScopedSnapshot, AbTestVariantKey } from "../../../lib/ab-test-protocol";
import { asIsoTimestamp, databaseOwnerId, type DatabaseExecutor, query, withTransaction } from "../database/database";

type TrialRow = {
  owner_id: string;
  trial_id: string;
  name: string;
  status: string;
  sampling_rate: number | string;
  created_at: unknown;
  stopped_at: unknown;
};

type VariantRow = {
  trial_id: string;
  variant_key: AbTestVariantKey;
  snapshot: unknown;
};

type AggregateRow = {
  trial_id: string;
  total_comparisons: number | string;
  completed_comparisons: number | string;
  option_a_wins: number | string;
  option_b_wins: number | string;
  variant_a_wins: number | string;
  variant_b_wins: number | string;
};

export type AbTestTrialRecord = {
  id: string;
  name: string;
  status: "active" | "stopped";
  samplingRate: number;
  variants: Partial<Record<AbTestVariantKey, unknown>>;
  history: AbTestComparisonRecord[];
  totalComparisons: number;
  completedComparisons: number;
  optionAWins: number;
  optionBWins: number;
  variantAWins: number;
  variantBWins: number;
  createdAt: string;
  stoppedAt: string | null;
};

export type AbTestComparisonRecord = {
  id: string;
  trialId: string;
  conversationId: string;
  turnId: string;
  displayAVariant: AbTestVariantKey;
  optionAResponseId: string | null;
  optionBResponseId: string | null;
  selectedLabel: AbTestVariantKey | null;
  createdAt: string;
  selectedAt: string | null;
};

type ComparisonRow = {
  comparison_id: string;
  trial_id: string;
  conversation_id: string;
  turn_id: string;
  display_a_variant: AbTestVariantKey;
  option_a_response_id: string | null;
  option_b_response_id: string | null;
  selected_label: AbTestVariantKey | null;
  created_at: unknown;
  selected_at: unknown;
};

function comparisonFromRow(row: ComparisonRow): AbTestComparisonRecord {
  return {
    id: String(row.comparison_id),
    trialId: String(row.trial_id),
    conversationId: String(row.conversation_id),
    turnId: String(row.turn_id),
    displayAVariant: row.display_a_variant,
    optionAResponseId: row.option_a_response_id ?? null,
    optionBResponseId: row.option_b_response_id ?? null,
    selectedLabel: row.selected_label ?? null,
    createdAt: asIsoTimestamp(row.created_at),
    selectedAt: row.selected_at == null ? null : asIsoTimestamp(row.selected_at),
  };
}

function trialFromRows(trial: TrialRow, variants: VariantRow[], aggregate: AggregateRow | undefined, history: ComparisonRow[]): AbTestTrialRecord {
  return {
    id: String(trial.trial_id),
    name: String(trial.name),
    status: trial.status as AbTestTrialRecord["status"],
    samplingRate: Number(trial.sampling_rate),
    variants: Object.fromEntries(variants.filter((variant) => variant.trial_id === trial.trial_id).map((variant) => [variant.variant_key, variant.snapshot])) as Partial<Record<AbTestVariantKey, unknown>>,
    history: history.filter((comparison) => comparison.trial_id === trial.trial_id).map(comparisonFromRow),
    totalComparisons: Number(aggregate?.total_comparisons ?? 0),
    completedComparisons: Number(aggregate?.completed_comparisons ?? 0),
    optionAWins: Number(aggregate?.option_a_wins ?? 0),
    optionBWins: Number(aggregate?.option_b_wins ?? 0),
    variantAWins: Number(aggregate?.variant_a_wins ?? 0),
    variantBWins: Number(aggregate?.variant_b_wins ?? 0),
    createdAt: asIsoTimestamp(trial.created_at),
    stoppedAt: trial.stopped_at == null ? null : asIsoTimestamp(trial.stopped_at),
  };
}

export async function listAbTestTrialRows(ownerId: string): Promise<AbTestTrialRecord[]> {
  const owner = databaseOwnerId(ownerId);
  const [trials, variants, aggregates, comparisons] = await Promise.all([
    query<TrialRow>("select owner_id,trial_id,name,status,sampling_rate,created_at,stopped_at from ab_test_trials where owner_id=$1 order by created_at desc,trial_id", [owner]),
    query<VariantRow>("select trial_id,variant_key,snapshot from ab_test_variants where owner_id=$1 order by trial_id,variant_key", [owner]),
    query<AggregateRow>(`select trial_id,
      count(*)::int as total_comparisons,
      count(*) filter (where selected_label is not null)::int as completed_comparisons,
      count(*) filter (where selected_label='a')::int as option_a_wins,
      count(*) filter (where selected_label='b')::int as option_b_wins,
      count(*) filter (where (display_a_variant='a' and selected_label='a') or (display_a_variant='b' and selected_label='b'))::int as variant_a_wins,
      count(*) filter (where (display_a_variant='a' and selected_label='b') or (display_a_variant='b' and selected_label='a'))::int as variant_b_wins
      from ab_test_comparisons where owner_id=$1 group by trial_id`, [owner]),
    query<ComparisonRow>(`select comparison_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label,created_at,selected_at
      from ab_test_comparisons where owner_id=$1 order by created_at desc,comparison_id`, [owner]),
  ]);
  const aggregatesByTrial = new Map(aggregates.map((aggregate) => [aggregate.trial_id, aggregate]));
  return trials.map((trial) => trialFromRows(trial, variants, aggregatesByTrial.get(trial.trial_id), comparisons));
}

export async function getAbTestTrialRow(ownerId: string, trialId: string): Promise<AbTestTrialRecord | null> {
  return (await listAbTestTrialRows(ownerId)).find((trial) => trial.id === trialId) ?? null;
}

export async function listAbTestVariantRows(ownerId: string, trialId: string): Promise<VariantRow[]> {
  return query<VariantRow>("select trial_id,variant_key,snapshot from ab_test_variants where owner_id=$1 and trial_id=$2 order by variant_key", [databaseOwnerId(ownerId), trialId]);
}

export async function insertAbTestTrialRows(
  ownerId: string,
  input: { name: string; variants: { a: AbTestRequestScopedSnapshot; b: AbTestRequestScopedSnapshot } },
  samplingRate: number,
): Promise<string> {
  const owner = databaseOwnerId(ownerId);
  const trialId = randomUUID();
  const now = new Date().toISOString();
  await withTransaction(async (transaction) => {
    await transaction.unsafe(
      "insert into ab_test_trials(owner_id,trial_id,name,status,sampling_rate,created_at,updated_at) values($1,$2,$3,'active',$4,$5,$5)",
      [owner, trialId, input.name, samplingRate, now],
    );
    await insertVariant(transaction, owner, trialId, "a", input.variants.a, now);
    await insertVariant(transaction, owner, trialId, "b", input.variants.b, now);
  });
  return trialId;
}

async function insertVariant(
  transaction: DatabaseExecutor,
  owner: string,
  trialId: string,
  key: AbTestVariantKey,
  snapshot: AbTestRequestScopedSnapshot,
  now: string,
): Promise<void> {
  await transaction.unsafe(
    "insert into ab_test_variants(owner_id,trial_id,variant_key,snapshot,created_at) values($1,$2,$3,$4::jsonb,$5)",
    [owner, trialId, key, JSON.stringify(snapshot), now],
  );
}

export async function stopAbTestTrialRow(ownerId: string, trialId: string): Promise<boolean> {
  const rows = await query<{ trial_id: string }>(`update ab_test_trials
    set status='stopped',stopped_at=coalesce(stopped_at,clock_timestamp()),updated_at=clock_timestamp()
    where owner_id=$1 and trial_id=$2 returning trial_id`, [databaseOwnerId(ownerId), trialId]);
  return rows.length > 0;
}

export async function insertAbTestComparisonRow(input: {
  ownerId: string;
  trialId: string;
  conversationId: string;
  turnId: string;
  displayAVariant: AbTestVariantKey;
  responseIds: { a: string | null; b: string | null };
}): Promise<AbTestComparisonRecord | null> {
  const owner = databaseOwnerId(input.ownerId);
  return withTransaction(async (transaction) => {
    const [inserted] = await transaction.unsafe<ComparisonRow>(`insert into ab_test_comparisons(
      owner_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id
    ) select $1,$2,$3,$4,$5,$6,$7
      where exists (select 1 from ab_test_trials where owner_id=$1 and trial_id=$2 and status='active')
      on conflict (owner_id,trial_id,conversation_id,turn_id) do nothing
      returning comparison_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label,created_at,selected_at`, [
      owner,
      input.trialId,
      input.conversationId,
      input.turnId,
      input.displayAVariant,
      input.displayAVariant === "a" ? input.responseIds.a : input.responseIds.b,
      input.displayAVariant === "a" ? input.responseIds.b : input.responseIds.a,
    ]);
    if (inserted) return comparisonFromRow(inserted);
    const [existing] = await transaction.unsafe<ComparisonRow>(`select comparison_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label,created_at,selected_at
      from ab_test_comparisons where owner_id=$1 and trial_id=$2 and conversation_id=$3 and turn_id=$4`, [owner, input.trialId, input.conversationId, input.turnId]);
    return existing ? comparisonFromRow(existing) : null;
  });
}

export async function getAbTestComparisonRow(ownerId: string, trialId: string, comparisonId: string): Promise<AbTestComparisonRecord | null> {
  const [row] = await query<ComparisonRow>(`select comparison_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label,created_at,selected_at
    from ab_test_comparisons where owner_id=$1 and trial_id=$2 and comparison_id=$3`, [databaseOwnerId(ownerId), trialId, comparisonId]);
  return row ? comparisonFromRow(row) : null;
}

export async function deletePendingAbTestComparisonRow(ownerId: string, trialId: string, comparisonId: string): Promise<void> {
  await query(
    "delete from ab_test_comparisons where owner_id=$1 and trial_id=$2 and comparison_id=$3 and selected_label is null",
    [databaseOwnerId(ownerId), trialId, comparisonId],
  );
}

export async function voteForAbTestComparisonRow(ownerId: string, trialId: string, comparisonId: string, selection: AbTestVariantKey): Promise<{ comparison: AbTestComparisonRecord; conflict: boolean } | null> {
  const owner = databaseOwnerId(ownerId);
  return withTransaction(async (transaction) => {
    const [current] = await transaction.unsafe<ComparisonRow>(`select comparison_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label,created_at,selected_at
      from ab_test_comparisons where owner_id=$1 and trial_id=$2 and comparison_id=$3 for update`, [owner, trialId, comparisonId]);
    if (!current) return null;
    if (current.selected_label !== null) return { comparison: comparisonFromRow(current), conflict: current.selected_label !== selection };
    const [updated] = await transaction.unsafe<ComparisonRow>(`update ab_test_comparisons set selected_label=$1,selected_at=clock_timestamp(),updated_at=clock_timestamp()
      where owner_id=$2 and trial_id=$3 and comparison_id=$4 and selected_label is null
      returning comparison_id,trial_id,conversation_id,turn_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label,created_at,selected_at`, [selection, owner, trialId, comparisonId]);
    return updated ? { comparison: comparisonFromRow(updated), conflict: false } : { comparison: comparisonFromRow(current), conflict: current.selected_label !== selection };
  });
}
