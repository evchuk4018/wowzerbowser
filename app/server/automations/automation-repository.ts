import "server-only";
import type { Automation, AutomationMutation } from "../../../lib/automation-protocol";
import { asIsoTimestamp, databaseOwnerId, jsonb, query, withTransaction } from "../database/database";
const columns = "id,name,kind,instructions,schedule,time_zone,status,next_run_at,last_run_at,last_outcome,last_error,consecutive_failures,created_at,updated_at";

function value(row: Record<string, unknown>): Automation {
  return {
    id: String(row.id), name: String(row.name), kind: row.kind as Automation["kind"], instructions: String(row.instructions),
    schedule: row.schedule as Automation["schedule"], timeZone: String(row.time_zone), status: row.status as Automation["status"],
    nextRunAt: row.next_run_at == null ? null : asIsoTimestamp(row.next_run_at), lastRunAt: row.last_run_at == null ? null : asIsoTimestamp(row.last_run_at), lastOutcome: row.last_outcome as Automation["lastOutcome"],
    lastError: row.last_error as string | null, consecutiveFailures: Number(row.consecutive_failures),
    createdAt: asIsoTimestamp(row.created_at), updatedAt: asIsoTimestamp(row.updated_at),
  };
}

export async function listAutomationRows(ownerId: string): Promise<Automation[]> {
  return (await query<Record<string, unknown>>(`select ${columns} from automations where owner_id=$1 and deleted_at is null order by updated_at desc`, [databaseOwnerId(ownerId)])).map(value);
}

export async function getAutomationRow(ownerId: string, id: string): Promise<Automation | null> {
  const [row] = await query<Record<string, unknown>>(`select ${columns} from automations where owner_id=$1 and id=$2 and deleted_at is null`, [databaseOwnerId(ownerId), id]);
  return row ? value(row) : null;
}

export async function insertAutomationRow(ownerId: string, input: AutomationMutation, nextRunAt: string | null): Promise<Automation> {
  const [row] = await query<Record<string, unknown>>(`insert into automations(owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at)
    values($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning ${columns}`, [databaseOwnerId(ownerId), input.name, input.kind, input.instructions, jsonb(input.schedule), input.timeZone, input.status ?? "active", nextRunAt]);
  return value(row);
}

export async function updateAutomationRow(ownerId: string, id: string, values: Record<string, unknown>): Promise<Automation | null> {
  const allowed = ["name", "kind", "instructions", "schedule", "time_zone", "status", "next_run_at"];
  const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
  if (!entries.length) return getAutomationRow(ownerId, id);
  const parameters: unknown[] = [];
  const assignments = entries.map(([key, raw]) => {
    parameters.push(key === "schedule" ? jsonb(raw) : raw);
    return `${key}=$${parameters.length}${key === "schedule" ? "::jsonb" : ""}`;
  });
  parameters.push(new Date().toISOString(), databaseOwnerId(ownerId), id);
  const [row] = await query<Record<string, unknown>>(`update automations set ${assignments.join(",")},updated_at=$${parameters.length - 2} where owner_id=$${parameters.length - 1} and id=$${parameters.length} and deleted_at is null returning ${columns}`, parameters);
  return row ? value(row) : null;
}

export async function softDeleteAutomationRow(ownerId: string, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await query<{ id: string }>("update automations set deleted_at=$1,status='paused',next_run_at=null,updated_at=$1 where owner_id=$2 and id=$3 and deleted_at is null returning id", [now, databaseOwnerId(ownerId), id]);
  return rows.length > 0;
}

export async function claimDueAutomationRuns(limit = 4): Promise<Array<{ id: string; owner_id: string; automation_id: string; scheduled_for: string }>> {
  return query<{ id: string; owner_id: string; automation_id: string; scheduled_for: string }>("select id,owner_id,automation_id,scheduled_for from claim_due_automations($1)", [limit]);
}

export async function finishAutomationRun(runId: string, input: { outcome: "notified" | "no_match" | "failed"; matched?: boolean; title?: string; output?: string; error?: string; conversationId?: string; nextRunAt: string | null; pause: boolean }): Promise<void> {
  const now = new Date().toISOString();
  await withTransaction(async (tx) => {
    const [run] = await tx.unsafe<{ owner_id: string; automation_id: string }>("select owner_id,automation_id from automation_runs where id=$1 for update", [runId]);
    if (!run) throw new Error("Automation run not found.");
  const runStatus = input.outcome;
    await tx.unsafe("update automation_runs set status=$1,matched=$2,title=$3,output=$4,error=$5,conversation_id=$6,lease_expires_at=null,completed_at=$7,updated_at=$7 where id=$8", [runStatus, input.matched ?? null, input.title ?? null, input.output ?? null, input.error ?? null, input.conversationId ?? null, now, runId]);
    const [automation] = await tx.unsafe<{ consecutive_failures: number }>("select consecutive_failures from automations where id=$1 and owner_id=$2 for update", [run.automation_id, run.owner_id]);
    if (!automation) throw new Error("Automation not found.");
    const failures = input.outcome === "failed" ? Number(automation.consecutive_failures) + 1 : 0;
    const shouldPause = input.pause || failures >= 3;
    await tx.unsafe("update automations set status=$1,next_run_at=$2,last_outcome=$3,last_error=$4,consecutive_failures=$5,updated_at=$6 where id=$7 and owner_id=$8", [shouldPause ? "paused" : "active", shouldPause ? null : input.nextRunAt, input.outcome, input.error ?? null, failures, now, run.automation_id, run.owner_id]);
  });
}
