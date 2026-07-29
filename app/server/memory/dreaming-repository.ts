import "server-only";

import type { DreamingAction, DreamingSource } from "../../../lib/user-memory";
import { getServerClient } from "../../auth/supabase-server-adapter";

const db = () => getServerClient();

export type DreamingRun = {
  id: string;
  ownerId: string;
  status: "queued" | "running" | "completed" | "failed";
  attemptCount: number;
  model: string | null;
  actionPlan: { actions: DreamingAction[] } | null;
  lastError: string | null;
};

type SourceRow = {
  job_id: string;
  sequence: number | string;
  conversation_id: string;
  completed_at: string;
};

export async function registerCompletedJobForDreaming(
  ownerId: string,
  conversationId: string,
  jobId: string,
): Promise<void> {
  const { data, error } = await db().from("chat_jobs").select("status,completed_at")
    .eq("owner_id", ownerId).eq("conversation_id", conversationId).eq("job_id", jobId).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "completed" || !data.completed_at) return;
  const result = await db().from("dreaming_completed_jobs").upsert({
    owner_id: ownerId,
    job_id: jobId,
    conversation_id: conversationId,
    completed_at: data.completed_at,
  }, { onConflict: "owner_id,job_id", ignoreDuplicates: true });
  if (result.error) throw result.error;
}

export async function claimDreamingRun(ownerId: string): Promise<string | null> {
  const { data, error } = await db().rpc("claim_user_dreaming_run", { p_owner_id: ownerId });
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

export async function getDreamingRun(ownerId: string, runId: string): Promise<DreamingRun | null> {
  const { data, error } = await db().from("dreaming_runs").select("id,owner_id,status,attempt_count,model,action_plan,last_error")
    .eq("owner_id", ownerId).eq("id", runId).maybeSingle();
  if (error) throw error;
  return data ? {
    id: data.id,
    ownerId: data.owner_id,
    status: data.status as DreamingRun["status"],
    attemptCount: Number(data.attempt_count),
    model: typeof data.model === "string" ? data.model : null,
    actionPlan: data.action_plan && typeof data.action_plan === "object" && !Array.isArray(data.action_plan)
      && Array.isArray((data.action_plan as { actions?: unknown }).actions)
      ? { actions: (data.action_plan as { actions: DreamingAction[] }).actions }
      : null,
    lastError: typeof data.last_error === "string" ? data.last_error : null,
  } : null;
}

export async function getDreamingSources(ownerId: string, runId: string): Promise<DreamingSource[] | null> {
  const { data, error } = await db().from("dreaming_run_sources")
    .select("job_id,sequence,conversation_id,completed_at")
    .eq("owner_id", ownerId).eq("run_id", runId).order("sequence");
  if (error) throw error;
  const rows = (data ?? []) as SourceRow[];
  if (rows.length !== 3) return null;
  const newestByChat = new Map<string, SourceRow>();
  rows.forEach((row) => newestByChat.set(row.conversation_id, row));
  const newestRows = [...newestByChat.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const jobs = newestRows.map((row) => row.job_id);
  const summaries = await db().from("chat_summary_jobs").select("source_job_id,result_summary,status")
    .eq("owner_id", ownerId).in("source_job_id", jobs);
  if (summaries.error) throw summaries.error;
  const summaryByJob = new Map((summaries.data ?? [])
    .filter((row) => row.status === "completed" && typeof row.result_summary === "string")
    .map((row) => [row.source_job_id as string, row.result_summary as string]));
  if (newestRows.some((row) => !summaryByJob.has(row.job_id))) return null;
  return newestRows.map((row) => ({
    jobId: row.job_id,
    chatId: row.conversation_id,
    completedAt: row.completed_at,
    summary: summaryByJob.get(row.job_id) ?? "",
  }));
}

export async function beginDreamingAttempt(ownerId: string, runId: string, expectedAttempt: number): Promise<boolean> {
  const now = new Date();
  const { data, error } = await db().from("dreaming_runs").update({
    status: "running",
    attempt_count: expectedAttempt + 1,
    started_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + 120_000).toISOString(),
    updated_at: now.toISOString(),
  }).eq("owner_id", ownerId).eq("id", runId).eq("status", "queued").eq("attempt_count", expectedAttempt)
    .select("id").maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function hasAppliedDreamingAction(runId: string, actionIndex: number): Promise<boolean> {
  const { data, error } = await db().from("dreaming_applied_actions").select("action_index")
    .eq("run_id", runId).eq("action_index", actionIndex).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function saveDreamingActionPlan(
  ownerId: string,
  runId: string,
  model: string,
  actionPlan: { actions: DreamingAction[] },
): Promise<void> {
  const { data, error } = await db().from("dreaming_runs").update({
    model,
    action_plan: actionPlan,
    updated_at: new Date().toISOString(),
  }).eq("owner_id", ownerId).eq("id", runId).eq("status", "running")
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("The dreaming run changed while its action plan was being saved.");
}

export async function markDreamingActionApplied(runId: string, actionIndex: number): Promise<void> {
  const { error } = await db().from("dreaming_applied_actions").upsert(
    { run_id: runId, action_index: actionIndex },
    { onConflict: "run_id,action_index", ignoreDuplicates: true },
  );
  if (error) throw error;
}

export async function completeDreamingRun(
  ownerId: string,
  runId: string,
  profileRevision: number,
  model: string,
  actionPlan: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db().from("dreaming_runs").update({
    status: "completed",
    profile_revision: profileRevision,
    model,
    action_plan: actionPlan,
    lease_expires_at: null,
    completed_at: now,
    updated_at: now,
    last_error: null,
  }).eq("owner_id", ownerId).eq("id", runId).eq("status", "running");
  if (error) throw error;
}

export async function failDreamingRun(ownerId: string, runId: string, attemptCount: number, message: string): Promise<void> {
  const terminal = attemptCount >= 3;
  const now = new Date().toISOString();
  const { error } = await db().from("dreaming_runs").update({
    status: terminal ? "failed" : "queued",
    lease_expires_at: null,
    last_error: message.slice(0, 240),
    updated_at: now,
    ...(terminal ? { completed_at: now } : {}),
  }).eq("owner_id", ownerId).eq("id", runId).eq("status", "running");
  if (error) throw error;
}
