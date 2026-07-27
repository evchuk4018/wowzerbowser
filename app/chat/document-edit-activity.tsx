"use client";

import type { ChatDocumentActivity } from "../../lib/chat-history";
import { formatDuration } from "./format-duration";
import { useEffect, useState } from "react";

function useLiveDuration(startedAt?: number, running = false) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

export function DocumentEditActivity({ activity }: { activity: ChatDocumentActivity }) {
  const edit = activity.result?.documentEdit;
  const label = activity.call.name === "inspect_pdf_editability"
    ? "Inspecting PDF"
    : activity.call.name === "edit_source_backed_document"
      ? "Editing source and rerendering"
      : activity.call.name === "edit_pdf"
        ? "Applying PDF edits"
        : "Comparing document revisions";
  const status = activity.status === "running" ? "Running" : activity.status === "completed" ? "Completed" : "Failed";
  const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running");
  const duration = activity.durationMs ?? liveDuration;
  const revision = edit?.kind === "revision" ? edit : null;
  return <div className={`document-edit-activity document-edit-activity-${activity.status}`}>
    <div className="document-edit-summary"><span>{label}</span><span>{status}</span>{duration !== undefined && <span>{formatDuration(duration)}</span>}</div>
    {revision && <div className="document-edit-details"><span>Method: {revision.method}</span><span>Changed pages: {revision.changedPages.length ? revision.changedPages.join(", ") : "none"}</span>{revision.warnings.length > 0 && <span>Warnings: {revision.warnings.join("; ")}</span>}</div>}
    {activity.status === "failed" && activity.result?.stderr && <div className="document-edit-error">{activity.result.stderr}</div>}
  </div>;
}
