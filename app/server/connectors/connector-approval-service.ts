import "server-only";

import type { ConnectorApprovalDecision, ConnectorApprovalSummary } from "../../../lib/connector-protocol";
import { createApproval, getApproval, readApprovalStatus, resolveApproval, setPermission } from "./connector-repository";
import { redactConnectorValue } from "./connector-redaction";
import { getServerClient } from "../../auth/supabase-server-adapter";

const APPROVAL_RETRY_INITIAL_MS = 300;
const APPROVAL_RETRY_MAX_MS = 1_500;

function waitForApprovalRetry(signal: AbortSignal | undefined, attempt: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const ceiling = Math.min(APPROVAL_RETRY_MAX_MS, APPROVAL_RETRY_INITIAL_MS * (2 ** attempt));
    const delay = Math.round(ceiling * (0.8 + Math.random() * 0.4));
    const timer = setTimeout(() => finish(true), delay);
    const onAbort = () => finish(false);
    const finish = (continueWaiting: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(continueWaiting);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function requestConnectorApproval(values: {
  ownerId: string; jobId?: string; conversationId?: string; connectorId: string; connectionId: string;
  connectorName: string; accountLabel: string | null; toolName: string; description: string; access: "read" | "write" | "destructive"; arguments: Record<string, unknown>;
}): Promise<{ id: string; summary: ConnectorApprovalSummary }> {
  const id = await createApproval({ ownerId: values.ownerId, jobId: values.jobId, conversationId: values.conversationId, connectorId: values.connectorId, connectionId: values.connectionId, toolName: values.toolName, description: values.description, access: values.access, importantArguments: redactConnectorValue(values.arguments) as Record<string, unknown> });
  if (values.jobId && values.conversationId) await getServerClient().from("chat_jobs").update({ status: "awaiting_approval", updated_at: new Date().toISOString() }).eq("owner_id", values.ownerId).eq("conversation_id", values.conversationId).eq("job_id", values.jobId).eq("status", "running");
  return { id, summary: { approvalId: id, ...(values.jobId ? { jobId: values.jobId } : {}), connectorId: values.connectorId, connectorName: values.connectorName, connectionId: values.connectionId, accountLabel: values.accountLabel, toolName: values.toolName, description: values.description, access: values.access, importantArguments: redactConnectorValue(values.arguments) as Record<string, unknown>, createdAt: new Date().toISOString() } };
}

export async function resolveConnectorApproval(ownerId: string, approvalId: string, decision: ConnectorApprovalDecision): Promise<boolean> {
  const approval = await getApproval(ownerId, approvalId);
  if (!approval || approval.status !== "pending") return false;
  const resolved = await resolveApproval(ownerId, approvalId, decision);
  if (resolved && approval.job_id && approval.conversation_id) await getServerClient().from("chat_jobs").update({ status: "running", updated_at: new Date().toISOString() }).eq("owner_id", ownerId).eq("conversation_id", approval.conversation_id).eq("job_id", approval.job_id).eq("status", "awaiting_approval");
  if (resolved && decision === "always_allow" && approval.access !== "destructive") await setPermission(ownerId, approval.connector_id, approval.tool_name, { approvalMode: "never" });
  return resolved;
}

export async function waitForConnectorApproval(ownerId: string, approvalId: string, signal?: AbortSignal): Promise<ConnectorApprovalDecision> {
  let retryAttempt = 0;
  while (!signal?.aborted) {
    const status = await readApprovalStatus(ownerId, approvalId);
    if (status === "allow_once" || status === "always_allow" || status === "deny") return status;
    if (!(await waitForApprovalRetry(signal, retryAttempt++))) break;
  }
  throw new Error("Connector approval was cancelled.");
}
