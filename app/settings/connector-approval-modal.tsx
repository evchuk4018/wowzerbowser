"use client";

import { useState } from "react";
import type { ConnectorApprovalSummary } from "../../lib/connector-protocol";
import { resolveConnectorApproval } from "./connectors-service";

export function ConnectorApprovalModal({ approval, hasSession, onResolved }: { approval: ConnectorApprovalSummary; hasSession: () => Promise<boolean>; onResolved?: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function resolve(decision: "allow_once" | "always_allow" | "deny") { setBusy(true); setError(""); try { if (!(await hasSession())) throw new Error("Sign in to resolve connector approval."); await resolveConnectorApproval(approval.approvalId, decision); onResolved?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Approval could not be resolved."); } finally { setBusy(false); } }
  return <div className="connector-approval-card" role="alert"><div><strong>Approval required</strong><p>{approval.connectorName} · {approval.accountLabel ?? "Connected account"}</p><p><strong>{approval.toolName}</strong> <span className={`connector-access connector-access-${approval.access}`}>{approval.access}</span></p><p>{approval.description}</p>{Object.keys(approval.importantArguments).length ? <pre>{JSON.stringify(approval.importantArguments, null, 2)}</pre> : null}{error && <small className="settings-error">{error}</small>}</div><div className="connector-approval-actions"><button type="button" className="settings-cancel" disabled={busy} onClick={() => void resolve("deny")}>Deny</button><button type="button" className="settings-cancel" disabled={busy} onClick={() => void resolve("always_allow")}>Always allow</button><button type="button" className="settings-save" disabled={busy} onClick={() => void resolve("allow_once")}>Allow once</button></div></div>;
}
