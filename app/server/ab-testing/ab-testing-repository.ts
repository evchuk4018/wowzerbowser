import "server-only";

import type { AbExperimentStatus, AbOverridePatch, AbVariant } from "../../../lib/ab-testing-protocol";
import { databaseOwnerId, jsonb, query, withTransaction, type DatabaseExecutor } from "../database/database";

export type AbExperimentRow = {
  id: string;
  name: string;
  status: AbExperimentStatus;
  variant_a: unknown;
  variant_b: unknown;
  created_at: unknown;
  updated_at: unknown;
  variant: AbVariant | null;
  exposures: number | string;
  completed: number | string;
  failed: number | string;
  selected: number | string;
  average_output_tps: number | string | null;
  average_cost_usd: number | string | null;
};

export type AbAssignmentRow = {
  id: string;
  experiment_id: string;
  experiment_name: string;
  variant: AbVariant;
  overrides: unknown;
  retry: boolean;
};

function owner(ownerId: string): string {
  return databaseOwnerId(ownerId);
}

function numberValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function createAbExperiment(
  ownerId: string,
  name: string,
  variantA: AbOverridePatch,
  variantB: AbOverridePatch,
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `insert into ab_experiments(owner_id,name,status,variant_a,variant_b)
     values($1,$2,'paused',$3::jsonb,$4::jsonb) returning id`,
    [owner(ownerId), name, jsonb(variantA), jsonb(variantB)],
  );
  if (!row?.id) throw new Error("The experiment could not be created.");
  return row.id;
}

export async function listAbExperiments(ownerId: string): Promise<AbExperimentRow[]> {
  return query<AbExperimentRow>(
    `select e.id,e.name,e.status,e.variant_a,e.variant_b,e.created_at,e.updated_at,
       a.variant,
       count(a.id)::integer as exposures,
       count(a.id) filter (where j.status='completed')::integer as completed,
       count(a.id) filter (where j.status in ('failed','cancelled'))::integer as failed,
       count(a.id) filter (where a.preferred)::integer as selected,
       avg(nullif(j.provider_metrics->>'outputTps','')::numeric) as average_output_tps,
       avg(nullif(j.provider_metrics->'runCost'->>'costUsd','')::numeric) as average_cost_usd
     from ab_experiments e
     left join ab_experiment_assignments a on a.owner_id=e.owner_id and a.experiment_id=e.id
     left join chat_jobs j on j.owner_id=a.owner_id and j.conversation_id=a.conversation_id and j.job_id=a.job_id
     where e.owner_id=$1
     group by e.id,e.name,e.status,e.variant_a,e.variant_b,e.created_at,e.updated_at,a.variant
     order by e.updated_at desc,e.name`,
    [owner(ownerId)],
  );
}

export async function setAbExperimentStatus(ownerId: string, experimentId: string, status: AbExperimentStatus): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "update ab_experiments set status=$1,updated_at=now() where owner_id=$2 and id=$3 returning id",
    [status, owner(ownerId), experimentId],
  );
  return rows.length > 0;
}

export async function deleteAbExperiment(ownerId: string, experimentId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "delete from ab_experiments where owner_id=$1 and id=$2 returning id",
    [owner(ownerId), experimentId],
  );
  return rows.length > 0;
}

function assignmentFromRow(row: AbAssignmentRow): AbAssignmentRow {
  return {
    id: row.id,
    experiment_id: row.experiment_id,
    experiment_name: row.experiment_name,
    variant: row.variant,
    overrides: row.overrides,
    retry: row.retry,
  };
}

async function assignmentInTransaction(
  transaction: DatabaseExecutor,
  ownerId: string,
  input: {
    conversationId: string;
    turnId: string;
    versionId: string;
    jobId: string;
    retryOfVersionId?: string;
  },
): Promise<AbAssignmentRow | null> {
  const ownerIdValue = owner(ownerId);
  await transaction.unsafe(
    "select pg_advisory_xact_lock(hashtext($1))",
    [`${ownerIdValue}:${input.conversationId}:${input.turnId}`],
  );
  const existing = await transaction.unsafe<AbAssignmentRow>(
    `select a.id,a.experiment_id,e.name as experiment_name,a.variant,a.overrides,a.retry
     from ab_experiment_assignments a join ab_experiments e on e.owner_id=a.owner_id and e.id=a.experiment_id
     where a.owner_id=$1 and a.version_id=$2`,
    [ownerIdValue, input.versionId],
  );
  if (existing[0]) return assignmentFromRow(existing[0]);

  if (input.retryOfVersionId) {
    const source = await transaction.unsafe<{
      experiment_id: string;
      experiment_name: string;
      variant: AbVariant;
      variant_a: unknown;
      variant_b: unknown;
    }>(
      `select a.experiment_id,e.name as experiment_name,a.variant,e.variant_a,e.variant_b
       from ab_experiment_assignments a join ab_experiments e on e.owner_id=a.owner_id and e.id=a.experiment_id
       where a.owner_id=$1 and a.version_id=$2`,
      [ownerIdValue, input.retryOfVersionId],
    );
    if (!source[0]) return null;
    const variant: AbVariant = source[0].variant === "a" ? "b" : "a";
    const overrides = (variant === "a" ? source[0].variant_a : source[0].variant_b) as AbOverridePatch;
    const inserted = await transaction.unsafe<AbAssignmentRow>(
      `insert into ab_experiment_assignments(owner_id,experiment_id,conversation_id,turn_id,version_id,job_id,variant,overrides,retry)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
       returning id,experiment_id,$9::text as experiment_name,variant,overrides,retry`,
      [ownerIdValue, source[0].experiment_id, input.conversationId, input.turnId, input.versionId, input.jobId, variant, jsonb(overrides), source[0].experiment_name],
    );
    return inserted[0] ? assignmentFromRow(inserted[0]) : null;
  }

  const sameTurn = await transaction.unsafe<{ id: string }>(
    "select id from ab_experiment_assignments where owner_id=$1 and conversation_id=$2 and turn_id=$3 limit 1",
    [ownerIdValue, input.conversationId, input.turnId],
  );
  if (sameTurn[0]) return null;

  const candidates = await transaction.unsafe<{
    id: string;
    name: string;
    variant_a: unknown;
    variant_b: unknown;
  }>(
    "select id,name,variant_a,variant_b from ab_experiments where owner_id=$1 and status='active' order by random()",
    [ownerIdValue],
  );
  const candidate = candidates[0];
  if (!candidate) return null;

  await transaction.unsafe(
    "select id from ab_experiments where owner_id=$1 and id=$2 for update",
    [ownerIdValue, candidate.id],
  );
  const [countRow] = await transaction.unsafe<{ count: number | string }>(
    "select count(*)::integer as count from ab_experiment_assignments where owner_id=$1 and experiment_id=$2 and retry=false",
    [ownerIdValue, candidate.id],
  );
  const exposureCount = Number(countRow?.count ?? 0);
  const variant: AbVariant = exposureCount % 2 === 0 ? "a" : "b";
  const overrides = (variant === "a" ? candidate.variant_a : candidate.variant_b) as AbOverridePatch;
  const inserted = await transaction.unsafe<AbAssignmentRow>(
    `insert into ab_experiment_assignments(owner_id,experiment_id,conversation_id,turn_id,version_id,job_id,variant,overrides,retry)
     values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false)
     returning id,experiment_id,$9::text as experiment_name,variant,overrides,retry`,
    [ownerIdValue, candidate.id, input.conversationId, input.turnId, input.versionId, input.jobId, variant, jsonb(overrides), candidate.name],
  );
  return inserted[0] ? assignmentFromRow(inserted[0]) : null;
}

export async function assignAbExperiment(
  ownerId: string,
  input: {
    conversationId: string;
    turnId: string;
    versionId: string;
    jobId: string;
    retryOfVersionId?: string;
  },
): Promise<AbAssignmentRow | null> {
  return withTransaction((transaction) => assignmentInTransaction(transaction, ownerId, input));
}

export async function markAbVersionPreferred(ownerId: string, conversationId: string, turnId: string, versionId: string): Promise<void> {
  await withTransaction(async (transaction) => {
    const ownerIdValue = owner(ownerId);
    await transaction.unsafe(
      "update ab_experiment_assignments set preferred=false where owner_id=$1 and conversation_id=$2 and turn_id=$3",
      [ownerIdValue, conversationId, turnId],
    );
    await transaction.unsafe(
      "update ab_experiment_assignments set preferred=true where owner_id=$1 and conversation_id=$2 and version_id=$3",
      [ownerIdValue, conversationId, versionId],
    );
  });
}

export function mapAbExperimentRows(rows: AbExperimentRow[]) {
  const byId = new Map<string, AbExperimentRow & { variants: Record<AbVariant, AbExperimentRow> }>();
  for (const row of rows) {
    const current = byId.get(row.id) ?? { ...row, variants: {} as Record<AbVariant, AbExperimentRow> };
    current.variants[row.variant ?? "a"] = row;
    byId.set(row.id, current);
  }
  return [...byId.values()].map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    variantA: row.variant_a as AbOverridePatch,
    variantB: row.variant_b as AbOverridePatch,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    results: {
      a: resultFor(row.variants.a),
      b: resultFor(row.variants.b),
    },
  }));
}

function resultFor(row: AbExperimentRow | undefined) {
  return {
    exposures: Number(row?.exposures ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    selected: Number(row?.selected ?? 0),
    averageOutputTps: numberValue(row?.average_output_tps ?? null),
    averageCostUsd: numberValue(row?.average_cost_usd ?? null),
  };
}
