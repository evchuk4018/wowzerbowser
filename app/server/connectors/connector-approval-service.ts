import "server-only";

import type { ConnectorApprovalDecision, ConnectorApprovalSummary } from "../../../lib/connector-protocol";
import { createApproval, getApproval, readApprovalStatus, resolveApproval, setPermission } from "./connector-repository";
import { redactConnectorValue } from "./connector-redaction";
import { resumeChatJobAfterApproval } from "../chat/chat-job-store";

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
  // Connector execution waits for the decision inside the active worker. Keep
  // that worker's lease valid so its tool-call and approval events can flush
  // before the user acts. Clearing the lease here makes the approval invisible
  // and aborts the exact tool call that is waiting for it.
  return { id, summary: { approvalId: id, ...(values.jobId ? { jobId: values.jobId } : {}), connectorId: values.connectorId, connectorName: values.connectorName, connectionId: values.connectionId, accountLabel: values.accountLabel, toolName: values.toolName, description: values.description, access: values.access, importantArguments: redactConnectorValue(values.arguments) as Record<string, unknown>, createdAt: new Date().toISOString() } };
}

export async function resolveConnectorApproval(ownerId: string, approvalId: string, decision: ConnectorApprovalDecision): Promise<boolean> {
  const approval = await getApproval(ownerId, approvalId);
  if (!approval || approval.status !== "pending") return false;
  const resolved = await resolveApproval(ownerId, approvalId, decision);
  if (resolved && approval.job_id && approval.conversation_id) await resumeChatJobAfterApproval(ownerId, approval.conversation_id, approval.job_id);
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
