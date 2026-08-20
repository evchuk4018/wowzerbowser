import "server-only";
import type { Automation, AutomationMutation } from "../../../lib/automation-protocol";
import { databaseOwnerId, isoTimestamp, jsonb, query, withTransaction } from "../database/database";
const columns = "id,name,kind,instructions,schedule,time_zone,status,next_run_at,last_run_at,last_outcome,last_error,consecutive_failures,created_at,updated_at";

export type AutomationRowInput = {
  name: string;
  kind: Automation["kind"];
  instructions: string;
  schedule: Automation["schedule"];
  timeZone: string;
  status?: Automation["status"];
};

function value(row: Record<string, unknown>): Automation {
  return {
    id: String(row.id), name: String(row.name), kind: row.kind as Automation["kind"], instructions: String(row.instructions),
    schedule: row.schedule as Automation["schedule"], timeZone: String(row.time_zone), status: row.status as Automation["status"],
    nextRunAt: row.next_run_at == null ? null : isoTimestamp(row.next_run_at), lastRunAt: row.last_run_at == null ? null : isoTimestamp(row.last_run_at), lastOutcome: row.last_outcome as Automation["lastOutcome"],
    lastError: row.last_error as string | null, consecutiveFailures: Number(row.consecutive_failures),
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
  };
}

export async function listAutomationRows(ownerId: string): Promise<Automation[]> {
  return (await query<Record<string, unknown>>(`select ${columns} from automations where owner_id=$1 and deleted_at is null order by updated_at desc`, [databaseOwnerId(ownerId)])).map(value);
}

export async function getAutomationRow(ownerId: string, id: string): Promise<Automation | null> {
  const [row] = await query<Record<string, unknown>>(`select ${columns} from automations where owner_id=$1 and id=$2 and deleted_at is null`, [databaseOwnerId(ownerId), id]);
  return row ? value(row) : null;
}

export async function insertAutomationRow(ownerId: string, input: AutomationRowInput | AutomationMutation, nextRunAt: string | null): Promise<Automation> {
  const [row] = await query<Record<string, unknown>>(`insert into automations(owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at)
    values($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning ${columns}`, [databaseOwnerId(ownerId), input.name, input.kind, input.instructions, jsonb(input.schedule), input.timeZone, input.status ?? "active", nextRunAt]);
  return value(row);
}

export async function cancelReminderRow(ownerId: string, id: string): Promise<Automation | null> {
  const now = new Date().toISOString();
  const [row] = await query<Record<string, unknown>>(`update automations
    set status='cancelled',next_run_at=null,updated_at=$1
    where owner_id=$2 and id=$3 and kind='reminder' and deleted_at is null and status in ('active','paused')
    returning ${columns}`, [now, databaseOwnerId(ownerId), id]);
  return row ? value(row) : null;
}

export async function updateAutomationRow(ownerId: string, id: string, values: Record<string, unknown>): Promise<Automation | null> {
  const allowed = ["name", "kind", "instructions", "schedule", "time_zone", "status", "next_run_at", "consecutive_failures", "last_error"];
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

export type ClaimedAutomationRun = {
  id: string;
  owner_id: string;
  automation_id: string;
  scheduled_for: string;
  lease_token: string;
  attempt_count: number;
};

export async function claimDueAutomationRuns(ownerId: string, limit = 1, leaseMs = 900_000): Promise<ClaimedAutomationRun[]> {
  return query<ClaimedAutomationRun>(
    "select id,owner_id,automation_id,scheduled_for,lease_token,attempt_count from claim_due_automations($1,$2,$3)",
    [databaseOwnerId(ownerId), Math.max(1, Math.min(limit, 4)), Math.max(60_000, Math.min(leaseMs, 3_600_000))],
  );
}

export async function heartbeatAutomationRun(ownerId: string, runId: string, leaseToken: string, leaseMs = 900_000): Promise<boolean> {
  const [row] = await query<{ heartbeat_automation_run: boolean }>(
    "select heartbeat_automation_run($1,$2::uuid,$3::uuid,$4) as heartbeat_automation_run",
    [databaseOwnerId(ownerId), runId, leaseToken, Math.max(60_000, Math.min(leaseMs, 3_600_000))],
  );
  return row?.heartbeat_automation_run === true;
}

export async function setAutomationRunAwaitingInput(
  runId: string,
  ownerId: string,
  leaseToken: string,
  questionId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const [row] = await query<{ id: string }>(
    "update automation_runs set status='awaiting_input',lease_expires_at=null,lease_token=null,updated_at=$1 where id=$2 and owner_id=$3 and status='running' and lease_token=$4::uuid returning id",
    [now, runId, databaseOwnerId(ownerId), leaseToken],
  );
  if (!row) return false;
  await query("update user_questions set automation_run_id=$1 where id=$2 and owner_id=$3", [runId, questionId, databaseOwnerId(ownerId)]).catch(() => undefined);
  return true;
}

export async function resumeAutomationRunAfterInput(
  ownerId: string,
  runId: string,
  answer: string,
): Promise<{ automationId: string; scheduledFor: string } | null> {
  const now = new Date().toISOString();
  return withTransaction(async (tx) => {
    const [run] = await tx.unsafe<{ id: string; automation_id: string; scheduled_for: unknown; status: string }>(
      "select id,automation_id,scheduled_for,status from automation_runs where id=$1 and owner_id=$2 and status='awaiting_input' for update",
      [runId, databaseOwnerId(ownerId)],
    );
    if (!run) return null;
    await tx.unsafe("update automation_runs set status='running',lease_token=gen_random_uuid(),lease_expires_at=$1,updated_at=$1 where id=$2 and owner_id=$3", [new Date(Date.now() + 15 * 60 * 1000).toISOString(), runId, databaseOwnerId(ownerId)]);
    const [updated] = await tx.unsafe<{ lease_token: string }>("select lease_token from automation_runs where id=$1 and owner_id=$2", [runId, databaseOwnerId(ownerId)]);
    void updated;
    return { automationId: String(run.automation_id), scheduledFor: isoTimestamp(run.scheduled_for) };
  });
}

export async function finishAwaitingInputAutomationRun(
  runId: string,
  input: { ownerId: string; answer: string; question: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  return withTransaction(async (tx) => {
    const [run] = await tx.unsafe<{ owner_id: string; automation_id: string; scheduled_for: unknown }>(
      "select owner_id,automation_id,scheduled_for from automation_runs where id=$1 and owner_id=$2 and status='awaiting_input' for update",
      [runId, databaseOwnerId(input.ownerId)],
    );
    if (!run) return false;
    await tx.unsafe(
      "update automation_runs set status='notified',matched=true,title=$1,output=$2,error=null,lease_expires_at=null,lease_token=null,completed_at=$3,updated_at=$3 where id=$4 and owner_id=$5",
      [input.question.slice(0, 160), input.answer.slice(0, 4000), now, runId, databaseOwnerId(input.ownerId)],
    );
    const [automation] = await tx.unsafe<{ consecutive_failures: number; status: string; deleted_at: string | null; schedule: unknown; time_zone: string; next_run_at: unknown }>(
      "select consecutive_failures,status,deleted_at,schedule,time_zone,next_run_at from automations where id=$1 and owner_id=$2 for update",
      [run.automation_id, databaseOwnerId(input.ownerId)],
    );
    if (!automation) throw new Error("Automation not found.");
    let nextRunAt: string | null = null;
    try {
      const { nextFutureAutomationRun } = await import("./automation-schedule");
      nextRunAt = nextFutureAutomationRun(automation.schedule as never, automation.time_zone, new Date(String(run.scheduled_for)), new Date()).toISOString();
    } catch { nextRunAt = null; }
    const shouldPause = automation.status !== "active" || automation.deleted_at !== null;
    const persistedNextRunAt = automation.next_run_at == null ? null : isoTimestamp(automation.next_run_at as never);
    const finalNextRunAt = shouldPause ? null : (persistedNextRunAt ?? nextRunAt);
    const nextStatus = shouldPause ? "paused" : "active";
    await tx.unsafe(
      "update automations set status=$1,next_run_at=$2,last_outcome='notified',last_error=null,consecutive_failures=0,updated_at=$3 where id=$4 and owner_id=$5",
      [nextStatus, finalNextRunAt, now, run.automation_id, databaseOwnerId(input.ownerId)],
    );
    return true;
  });
}

export async function expireAwaitingInputAutomationRuns(ownerId: string, leaseMs = 900_000): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const runs = await query<{ id: string; owner_id: string; automation_id: string; lease_token: string | null }>(
    "select id,owner_id,automation_id,lease_token from automation_runs where owner_id=$1 and status='awaiting_input' and updated_at <= $2",
    [databaseOwnerId(ownerId), cutoff],
  );
  let expired = 0;
  for (const run of runs) {
    try {
      const now = new Date().toISOString();
      await withTransaction(async (tx) => {
        const [locked] = await tx.unsafe<{ id: string }>("select id from automation_runs where id=$1 and owner_id=$2 and status='awaiting_input' for update", [run.id, databaseOwnerId(ownerId)]);
        if (!locked) return;
        await tx.unsafe("update automation_runs set status='expired',error='User did not answer within 24h.',lease_expires_at=null,lease_token=null,completed_at=$1,updated_at=$1 where id=$2 and owner_id=$3", [now, run.id, databaseOwnerId(ownerId)]);
        await tx.unsafe("update automations set last_outcome='failed',last_error='User did not answer within 24h.',consecutive_failures=consecutive_failures+1,updated_at=$1 where id=$2 and owner_id=$3", [now, run.automation_id, databaseOwnerId(ownerId)]);
        await tx.unsafe("update user_questions set status='expired',updated_at=$1 where automation_run_id=$2 and status='pending'", [now, run.id]);
      });
      expired += 1;
    } catch {}
  }
  return expired;
}

export async function finishAutomationRun(
  runId: string,
  input: {
    ownerId: string;
    leaseToken: string;
    outcome: "notified" | "no_match" | "failed";
    matched?: boolean;
    title?: string;
    output?: string;
    error?: string;
    conversationId?: string;
    nextRunAt: string | null;
    pause: boolean;
    complete?: boolean;
    now?: Date;
  },
): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  return withTransaction(async (tx) => {
    const [run] = await tx.unsafe<{ owner_id: string; automation_id: string }>(
      "select owner_id,automation_id from automation_runs where id=$1 and owner_id=$2 and status='running' and lease_token=$3::uuid for update",
      [runId, databaseOwnerId(input.ownerId), input.leaseToken],
    );
    if (!run) return false;
    const runStatus = input.outcome;
    await tx.unsafe(
      "update automation_runs set status=$1,matched=$2,title=$3,output=$4,error=$5,conversation_id=$6,lease_expires_at=null,lease_token=null,completed_at=$7,updated_at=$7 where id=$8 and owner_id=$9 and status='running'",
      [runStatus, input.matched ?? null, input.title ?? null, input.output ?? null, input.error ?? null, input.conversationId ?? null, now, runId, databaseOwnerId(input.ownerId)],
    );
    const [automation] = await tx.unsafe<{ consecutive_failures: number; status: string; deleted_at: string | null; next_run_at: unknown }>(
      "select consecutive_failures,status,deleted_at,next_run_at from automations where id=$1 and owner_id=$2 for update",
      [run.automation_id, databaseOwnerId(input.ownerId)],
    );
    if (!automation) throw new Error("Automation not found.");
    const failures = input.outcome === "failed" ? Number(automation.consecutive_failures) + 1 : 0;
    const shouldPause = automation.status !== "active" || automation.deleted_at !== null || input.pause || failures >= 3;
    const persistedNextRunAt = automation.next_run_at == null ? null : isoTimestamp(automation.next_run_at);
    const nextRunAt = shouldPause ? null : (persistedNextRunAt ?? input.nextRunAt);
    const nextStatus = input.complete
      ? "completed"
      : automation.status === "cancelled" || automation.status === "completed"
        ? automation.status
        : shouldPause ? "paused" : "active";
    await tx.unsafe(
      "update automations set status=$1,next_run_at=$2,last_outcome=$3,last_error=$4,consecutive_failures=$5,updated_at=$6 where id=$7 and owner_id=$8",
      [nextStatus, nextStatus === "completed" ? null : nextRunAt, input.outcome, input.error ?? null, failures, now, run.automation_id, databaseOwnerId(input.ownerId)],
    );
    return true;
  });
}
