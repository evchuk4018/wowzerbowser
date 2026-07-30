import "server-only";
import type { Automation, AutomationMutation } from "../../../lib/automation-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";

const db = () => getServerClient();
const columns = "id,name,kind,instructions,schedule,time_zone,status,next_run_at,last_run_at,last_outcome,last_error,consecutive_failures,created_at,updated_at";

function value(row: Record<string, unknown>): Automation {
  return {
    id: String(row.id), name: String(row.name), kind: row.kind as Automation["kind"], instructions: String(row.instructions),
    schedule: row.schedule as Automation["schedule"], timeZone: String(row.time_zone), status: row.status as Automation["status"],
    nextRunAt: row.next_run_at as string | null, lastRunAt: row.last_run_at as string | null, lastOutcome: row.last_outcome as Automation["lastOutcome"],
    lastError: row.last_error as string | null, consecutiveFailures: Number(row.consecutive_failures),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function listAutomationRows(ownerId: string): Promise<Automation[]> {
  const { data, error } = await db().from("automations").select(columns).eq("owner_id", ownerId).is("deleted_at", null).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => value(row));
}

export async function getAutomationRow(ownerId: string, id: string): Promise<Automation | null> {
  const { data, error } = await db().from("automations").select(columns).eq("owner_id", ownerId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  return data ? value(data) : null;
}

export async function insertAutomationRow(ownerId: string, input: AutomationMutation, nextRunAt: string | null): Promise<Automation> {
  const { data, error } = await db().from("automations").insert({
    owner_id: ownerId, name: input.name, kind: input.kind, instructions: input.instructions,
    schedule: input.schedule, time_zone: input.timeZone, status: input.status ?? "active", next_run_at: nextRunAt,
  }).select(columns).single();
  if (error) throw error;
  return value(data);
}

export async function updateAutomationRow(ownerId: string, id: string, values: Record<string, unknown>): Promise<Automation | null> {
  const { data, error } = await db().from("automations").update({ ...values, updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId).eq("id", id).is("deleted_at", null).select(columns).maybeSingle();
  if (error) throw error;
  return data ? value(data) : null;
}

export async function softDeleteAutomationRow(ownerId: string, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await db().from("automations").update({ deleted_at: now, status: "paused", next_run_at: null, updated_at: now })
    .eq("owner_id", ownerId).eq("id", id).is("deleted_at", null).select("id").maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function claimDueAutomationRuns(limit = 4): Promise<Array<{ id: string; owner_id: string; automation_id: string; scheduled_for: string }>> {
  const { data, error } = await db().rpc("claim_due_automations", { p_limit: limit });
  if (error) throw error;
  return data ?? [];
}

export async function finishAutomationRun(runId: string, input: { outcome: "notified" | "no_match" | "failed"; matched?: boolean; title?: string; output?: string; error?: string; conversationId?: string; nextRunAt: string | null; pause: boolean }): Promise<void> {
  const now = new Date().toISOString();
  const { data: run, error: readError } = await db().from("automation_runs").select("owner_id,automation_id").eq("id", runId).single();
  if (readError) throw readError;
  const runStatus = input.outcome;
  const { error } = await db().from("automation_runs").update({
    status: runStatus, matched: input.matched ?? null, title: input.title ?? null, output: input.output ?? null,
    error: input.error ?? null, conversation_id: input.conversationId ?? null, lease_expires_at: null,
    completed_at: now, updated_at: now,
  }).eq("id", runId);
  if (error) throw error;
  const { data: automation, error: automationError } = await db().from("automations").select("consecutive_failures").eq("id", run.automation_id).eq("owner_id", run.owner_id).single();
  if (automationError) throw automationError;
  const failures = input.outcome === "failed" ? Number(automation.consecutive_failures) + 1 : 0;
  const shouldPause = input.pause || failures >= 3;
  const { error: updateError } = await db().from("automations").update({
    status: shouldPause ? "paused" : "active", next_run_at: shouldPause ? null : input.nextRunAt,
    last_outcome: input.outcome, last_error: input.error ?? null, consecutive_failures: failures, updated_at: now,
  }).eq("id", run.automation_id).eq("owner_id", run.owner_id);
  if (updateError) throw updateError;
}
