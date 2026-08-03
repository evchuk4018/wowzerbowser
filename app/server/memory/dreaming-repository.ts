import "server-only";

import type { DreamingAction, DreamingSource } from "../../../lib/user-memory";
import { asIsoTimestamp, databaseOwnerId, jsonb, query } from "../database/database";

export type DreamingRun = {
  id: string; ownerId: string; status: "queued" | "running" | "completed" | "failed";
  attemptCount: number; model: string | null; actionPlan: { actions: DreamingAction[] } | null; lastError: string | null;
};
export type DreamingConsolidation = {
  ownerId: string; cycleNumber: number; sourceRunIds: string[]; status: "queued" | "running" | "completed" | "failed"; prompt: string; model: string | null;
};
type SourceRow = { job_id: string; sequence: number | string; conversation_id: string; completed_at: unknown };

export type CompletedChatJobForMemory = {
  conversationId: string;
  jobId: string;
};

export async function listCompletedChatJobsForMemory(ownerId: string, limit = 8): Promise<CompletedChatJobForMemory[]> {
  const rows = await query<{ conversation_id: string; job_id: string }>(
    `select jobs.conversation_id,jobs.job_id
       from chat_jobs jobs
      where jobs.owner_id=$1
        and jobs.status='completed'
        and jobs.completed_at is not null
        and (
          not exists (
            select 1 from chat_summary_jobs summaries
             where summaries.owner_id=jobs.owner_id
               and summaries.conversation_id=jobs.conversation_id
               and summaries.source_job_id=jobs.job_id
               and summaries.status='completed'
          )
          or not exists (
            select 1 from dreaming_completed_jobs completed
             where completed.owner_id=jobs.owner_id and completed.job_id=jobs.job_id
          )
        )
      order by jobs.completed_at,jobs.job_id
      limit $2`,
    [databaseOwnerId(ownerId), Math.max(1, Math.min(limit, 16))],
  );
  return rows.map((row) => ({ conversationId: row.conversation_id, jobId: row.job_id }));
}

export async function registerCompletedJobForDreaming(ownerId: string, conversationId: string, jobId: string): Promise<void> {
  const [job] = await query<{ status: string; completed_at: unknown }>("select status,completed_at from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [databaseOwnerId(ownerId), conversationId, jobId]);
  if (!job || job.status !== "completed" || !job.completed_at) return;
  await query("insert into dreaming_completed_jobs(owner_id,job_id,conversation_id,completed_at) values($1,$2,$3,$4) on conflict(owner_id,job_id) do nothing", [databaseOwnerId(ownerId), jobId, conversationId, job.completed_at]);
}

export async function claimDreamingRun(ownerId: string): Promise<string | null> {
  const [row] = await query<{ run_id: string | null }>("select claim_user_dreaming_run($1) as run_id", [databaseOwnerId(ownerId)]);
  return row?.run_id ?? null;
}

export async function recordDreamingCycle(ownerId: string, runId: string): Promise<number | null> {
  const [row] = await query<{ cycle_number: number | null }>("select record_dreaming_cycle($1,$2) as cycle_number", [databaseOwnerId(ownerId), runId]);
  return row?.cycle_number == null ? null : Number(row.cycle_number);
}

function consolidationFromRow(row: Record<string, unknown>): DreamingConsolidation {
  return { ownerId: String(row.owner_id), cycleNumber: Number(row.cycle_number), sourceRunIds: Array.isArray(row.source_run_ids) ? row.source_run_ids.filter((value): value is string => typeof value === "string") : [], status: row.status as DreamingConsolidation["status"], prompt: typeof row.prompt === "string" ? row.prompt : "", model: typeof row.model === "string" ? row.model : null };
}

export async function claimDreamingConsolidation(ownerId: string, cycleNumber?: number): Promise<DreamingConsolidation | null> {
  const parameters: unknown[] = [databaseOwnerId(ownerId), new Date().toISOString(), new Date(Date.now() + 120_000).toISOString()];
  let cycleClause = "";
  if (cycleNumber !== undefined) { parameters.push(cycleNumber); cycleClause = ` and cycle_number=$${parameters.length}`; }
  const [row] = await query<Record<string, unknown>>(`with candidate as (
      select owner_id,cycle_number from dreaming_consolidations
       where owner_id=$1 and (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at < $2)))${cycleClause}
       order by cycle_number for update skip locked limit 1
    ) update dreaming_consolidations d set status='running',lease_expires_at=$3,updated_at=$2 from candidate
      where d.owner_id=candidate.owner_id and d.cycle_number=candidate.cycle_number
      returning d.owner_id,d.cycle_number,d.source_run_ids,d.status,d.prompt,d.model`, parameters);
  return row ? consolidationFromRow(row) : null;
}

export async function getDreamingConsolidationSources(ownerId: string, runIds: string[]): Promise<DreamingSource[]> {
  if (!runIds.length) return [];
  const owner = databaseOwnerId(ownerId);
  const rows = await query<SourceRow & { run_id: string }>("select run_id,job_id,sequence,conversation_id,completed_at from dreaming_run_sources where owner_id=$1 and run_id=any($2::uuid[]) order by sequence", [owner, runIds]);
  const jobs = rows.map((row) => row.job_id);
  if (!jobs.length) return [];
  const summaries = await query<{ source_job_id: string; result_summary: string | null; status: string }>("select source_job_id,result_summary,status from chat_summary_jobs where owner_id=$1 and source_job_id=any($2::text[])", [owner, jobs]);
  const summaryByJob = new Map(summaries.filter((row) => row.status === "completed" && typeof row.result_summary === "string").map((row) => [row.source_job_id, row.result_summary!]));
  return rows.flatMap((row) => summaryByJob.has(row.job_id) ? [{ jobId: row.job_id, chatId: row.conversation_id, completedAt: asIsoTimestamp(row.completed_at), summary: summaryByJob.get(row.job_id) ?? "" }] : []);
}

export async function completeDreamingConsolidation(ownerId: string, cycleNumber: number, prompt: string, model: string): Promise<void> {
  const now = new Date().toISOString();
  const owner = databaseOwnerId(ownerId);
  await query("update user_memory_profiles set consolidated_prompt=$1,updated_at=$2 where owner_id=$3", [prompt, now, owner]);
  await query("update dreaming_consolidations set status='completed',prompt=$1,model=$2,lease_expires_at=null,completed_at=$3,updated_at=$3,last_error=null where owner_id=$4 and cycle_number=$5 and status='running'", [prompt, model, now, owner, cycleNumber]);
}

export async function failDreamingConsolidation(ownerId: string, cycleNumber: number, message: string): Promise<void> {
  await query("update dreaming_consolidations set status='queued',lease_expires_at=null,last_error=$1,updated_at=$2 where owner_id=$3 and cycle_number=$4 and status='running'", [message.slice(0, 240), new Date().toISOString(), databaseOwnerId(ownerId), cycleNumber]);
}

export async function getConsolidatedPrompt(ownerId: string): Promise<string> {
  const [row] = await query<{ consolidated_prompt: string }>("select consolidated_prompt from user_memory_profiles where owner_id=$1", [databaseOwnerId(ownerId)]);
  return typeof row?.consolidated_prompt === "string" ? row.consolidated_prompt : "";
}

export async function getDreamingRun(ownerId: string, runId: string): Promise<DreamingRun | null> {
  const [row] = await query<Record<string, unknown>>("select id,owner_id,status,attempt_count,model,action_plan,last_error from dreaming_runs where owner_id=$1 and id=$2", [databaseOwnerId(ownerId), runId]);
  if (!row) return null;
  return { id: String(row.id), ownerId: String(row.owner_id), status: row.status as DreamingRun["status"], attemptCount: Number(row.attempt_count), model: typeof row.model === "string" ? row.model : null, actionPlan: row.action_plan && typeof row.action_plan === "object" && !Array.isArray(row.action_plan) && Array.isArray((row.action_plan as { actions?: unknown }).actions) ? { actions: (row.action_plan as { actions: DreamingAction[] }).actions } : null, lastError: typeof row.last_error === "string" ? row.last_error : null };
}

export async function getDreamingSources(ownerId: string, runId: string): Promise<DreamingSource[] | null> {
  const owner = databaseOwnerId(ownerId);
  const rows = await query<SourceRow>("select job_id,sequence,conversation_id,completed_at from dreaming_run_sources where owner_id=$1 and run_id=$2 order by sequence", [owner, runId]);
  if (rows.length !== 3) return null;
  const newestByChat = new Map<string, SourceRow>();
  rows.forEach((row) => newestByChat.set(row.conversation_id, row));
  const newestRows = [...newestByChat.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const jobs = newestRows.map((row) => row.job_id);
  const summaries = await query<{ source_job_id: string; result_summary: string | null; status: string }>("select source_job_id,result_summary,status from chat_summary_jobs where owner_id=$1 and source_job_id=any($2::text[])", [owner, jobs]);
  const summaryByJob = new Map(summaries.filter((row) => row.status === "completed" && typeof row.result_summary === "string").map((row) => [row.source_job_id, row.result_summary!]));
  if (newestRows.some((row) => !summaryByJob.has(row.job_id))) return null;
  return newestRows.map((row) => ({ jobId: row.job_id, chatId: row.conversation_id, completedAt: asIsoTimestamp(row.completed_at), summary: summaryByJob.get(row.job_id) ?? "" }));
}

export async function beginDreamingAttempt(ownerId: string, runId: string, expectedAttempt: number): Promise<boolean> {
  const now = new Date();
  return (await query<{ id: string }>("update dreaming_runs set status='running',attempt_count=$1,started_at=$2,lease_expires_at=$3,updated_at=$2 where owner_id=$4 and id=$5 and status='queued' and attempt_count=$6 returning id", [expectedAttempt + 1, now.toISOString(), new Date(now.getTime() + 120_000).toISOString(), databaseOwnerId(ownerId), runId, expectedAttempt])).length > 0;
}

export async function hasAppliedDreamingAction(runId: string, actionIndex: number): Promise<boolean> {
  return (await query("select action_index from dreaming_applied_actions where run_id=$1 and action_index=$2", [runId, actionIndex])).length > 0;
}

export async function saveDreamingActionPlan(ownerId: string, runId: string, model: string, actionPlan: { actions: DreamingAction[] }): Promise<void> {
  const rows = await query<{ id: string }>("update dreaming_runs set model=$1,action_plan=$2::jsonb,updated_at=$3 where owner_id=$4 and id=$5 and status='running' returning id", [model, jsonb(actionPlan), new Date().toISOString(), databaseOwnerId(ownerId), runId]);
  if (!rows.length) throw new Error("The dreaming run changed while its action plan was being saved.");
}

export async function markDreamingActionApplied(runId: string, actionIndex: number): Promise<void> {
  await query("insert into dreaming_applied_actions(run_id,action_index) values($1,$2) on conflict(run_id,action_index) do nothing", [runId, actionIndex]);
}

export async function completeDreamingRun(ownerId: string, runId: string, profileRevision: number, model: string, actionPlan: unknown): Promise<void> {
  const now = new Date().toISOString();
  await query("update dreaming_runs set status='completed',profile_revision=$1,model=$2,action_plan=$3::jsonb,lease_expires_at=null,completed_at=$4,updated_at=$4,last_error=null where owner_id=$5 and id=$6 and status='running'", [profileRevision, model, jsonb(actionPlan), now, databaseOwnerId(ownerId), runId]);
}

export async function failDreamingRun(ownerId: string, runId: string, attemptCount: number, message: string): Promise<void> {
  const terminal = attemptCount >= 3;
  const now = new Date().toISOString();
  await query(`update dreaming_runs set status=$1,lease_expires_at=null,last_error=$2,updated_at=$3${terminal ? ",completed_at=$3" : ""} where owner_id=$4 and id=$5 and status='running'`, [terminal ? "failed" : "queued", message.slice(0, 240), now, databaseOwnerId(ownerId), runId]);
}
