"use client";

import type { ConnectorTool } from "../../lib/connector-protocol";

export function ConnectorPermissions({ tools, busy, onChange, onApprovalChange }: { tools: ConnectorTool[]; busy?: boolean; onChange: (tool: ConnectorTool, enabled: boolean) => void; onApprovalChange: (tool: ConnectorTool, mode: "never" | "always") => void }) {
  return <div className="connector-permissions"><h4>Tool permissions</h4>{tools.length ? tools.map((tool) => <div className="connector-permission-row" key={`${tool.connectorId}:${tool.name}`}><span><strong>{tool.name}</strong><small>{tool.description}</small><span className={`connector-access connector-access-${tool.access}`}>{tool.access}</span></span><span className="connector-account-actions"><label><small>Approval</small><select value={tool.access === "destructive" ? "always" : tool.approvalMode ?? "always"} disabled={busy || tool.access === "destructive"} onChange={(event) => onApprovalChange(tool, event.target.value as "never" | "always")}><option value="never">Never ask</option><option value="always">Ask every time</option></select></label><input type="checkbox" checked={tool.enabled} disabled={busy} onChange={(event) => onChange(tool, event.target.checked)} aria-label={`Enable ${tool.name}`} /></span></div>) : <p className="settings-status">No discovered tools yet.</p>}</div>;
}
