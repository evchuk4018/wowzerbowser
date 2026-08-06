"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "./format-duration";
import type { ChatResearchTraceEntry } from "../../lib/chat-protocol";
import type { ChatResearchSummaryRevision, ChatSubagentActivity } from "../../lib/chat-history";

export type SubagentActivity = ChatSubagentActivity;

const TRACE_LIMIT = 40;

function useLiveDuration(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

function summaryText(item: ChatResearchSummaryRevision): string | undefined {
  return item.summary.trim() || undefined;
}

function latestTitle(activity: SubagentActivity): string {
  const history = activity.summaryHistory ?? [];
  const latest = history.toReversed().map(summaryText).find(Boolean);
  return activity.summary?.trim() || latest || activity.title;
}

function traceLabel(item: ChatResearchTraceEntry): string {
  return item.label.trim() || "Research step";
}

export function SubagentDisclosure({ activity }: { activity: SubagentActivity }) {
  const [open, setOpen] = useState(false);
  const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running");
  const duration = activity.durationMs ?? liveDuration;
  const summaries = activity.summaryHistory ?? (activity.summary ? [{ revision: 0, summary: activity.summary }] : []);
  const trace = (activity.trace ?? []).slice(-TRACE_LIMIT);
  const statusLabel = activity.status[0].toUpperCase() + activity.status.slice(1);

  return (
    <div className={`subagent-activity subagent-activity-${activity.status}`}>
      <button
        type="button"
        className="subagent-activity-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="python-nested-chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>
        <span className="subagent-activity-heading">
          <span className="subagent-activity-title">{latestTitle(activity)}</span>
          <span className="subagent-activity-agent">{activity.title}</span>
        </span>
        <span className="python-activity-status" role="status" aria-live="polite">{statusLabel}</span>
        {duration !== undefined && <span className="python-activity-duration">{formatDuration(duration)}</span>}
      </button>
      {open && (
        <div className="subagent-activity-details">
          <div className="subagent-activity-section">
            <span className="subagent-activity-section-title">Updates</span>
            {summaries.length ? (
              <ol className="subagent-summary-history">
                {summaries.map((item, index) => {
                  const text = summaryText(item);
                  return text ? <li key={`${index}-${text}`}>{text}</li> : null;
                })}
              </ol>
            ) : <p className="subagent-activity-empty">Waiting for an update…</p>}
          </div>
          {trace.length > 0 && (
            <div className="subagent-activity-section">
              <span className="subagent-activity-section-title">Activity</span>
              <ol className="subagent-trace">
                {trace.map((item, index) => {
                  const detail = typeof item === "string" ? undefined : item;
                  return (
                    <li key={`${index}-${traceLabel(item)}`}>
                      <span>{traceLabel(item)}</span>
                      {detail?.status && <span className="subagent-trace-meta">{detail.status}</span>}
                      {detail?.detail && <span className="subagent-trace-meta">{detail.detail}</span>}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
