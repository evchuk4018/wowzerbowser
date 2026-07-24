"use client";

import { useEffect, useState } from "react";
import type {
  ChatArtifact,
  ChatToolCall,
  ChatToolResult,
} from "../../lib/chat-protocol";
import { AssistantResponse } from "./assistant-response";
import { fetchChatArtifact } from "./chat-service";

export type ReasoningActivity = {
  id: string;
  kind: "reasoning";
  round: number;
  content: string;
  status: "running" | "complete";
  startedAt?: number;
  durationMs?: number;
};

export type PythonActivity = {
  id: string;
  kind: "python";
  round: number;
  call: ChatToolCall;
  result?: ChatToolResult;
  status: "running" | "completed" | "failed";
  startedAt?: number;
  durationMs?: number;
};

export type AssistantActivity = ReasoningActivity | PythonActivity;

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function useLiveDuration(startedAt?: number, running = false) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

function ReasoningCard({ activity }: { activity: ReasoningActivity }) {
  const [open, setOpen] = useState(false);
  const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running");
  const duration = activity.durationMs ?? liveDuration;

  return (
    <section className={`reasoning-block ${open ? "reasoning-open" : ""}`}>
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-chevron" aria-hidden="true">›</span>
        <span>{activity.status === "running" ? "Thinking" : "Thought process"}</span>
        <span className="activity-round">Round {activity.round}</span>
        {duration !== undefined && (
          <span className="reasoning-duration">{formatDuration(duration)}</span>
        )}
      </button>
      {open && <div className="reasoning-content">{activity.content}</div>}
    </section>
  );
}

function PythonCard({ activity }: { activity: PythonActivity }) {
  const [open, setOpen] = useState(false);
  const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running");
  const duration = activity.durationMs ?? liveDuration;
  const statusLabel =
    activity.status === "running"
      ? "Running"
      : activity.status === "completed"
        ? "Completed"
        : "Failed";

  return (
    <section className={`python-activity python-activity-${activity.status}`}>
      <button
        type="button"
        className="python-activity-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="python-activity-icon" aria-hidden="true">&gt;_</span>
        <span className="python-activity-title">Python</span>
        <span className="python-activity-status" aria-live="polite">{statusLabel}</span>
        {duration !== undefined && (
          <span className="python-activity-duration">{formatDuration(duration)}</span>
        )}
        <span className="python-activity-chevron" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open && (
        <div className="python-activity-details">
          <div>
            <div className="python-activity-detail-label">Call</div>
            <pre>{JSON.stringify(activity.call, null, 2)}</pre>
          </div>
          {activity.result && (
            <div>
              <div className="python-activity-detail-label">Result</div>
              <pre>{JSON.stringify(activity.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ArtifactDownload({
  artifact,
  getAccessToken,
}: {
  artifact: ChatArtifact;
  getAccessToken: () => Promise<string | null>;
}) {
  const [state, setState] = useState<"idle" | "downloading" | "error">("idle");

  const download = async () => {
    if (state === "downloading") return;
    setState("downloading");
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Session expired");
      const blob = await fetchChatArtifact(artifact, accessToken);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = artifact.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setState("idle");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="artifact-download">
      <button type="button" disabled={state === "downloading"} onClick={() => void download()}>
        Created {artifact.name}
      </button>
      <span className="artifact-download-state" role="status" aria-live="polite">
        {state === "downloading" ? "Downloading…" : state === "error" ? "Download failed. Try again." : ""}
      </span>
    </div>
  );
}

export function AssistantActivityTimeline({
  activities,
  content,
  artifacts,
  getAccessToken,
}: {
  activities: AssistantActivity[];
  content: string;
  artifacts: ChatArtifact[];
  getAccessToken: () => Promise<string | null>;
}) {
  return (
    <>
      <div className="assistant-activity-timeline">
        {activities.map((activity) =>
          activity.kind === "reasoning" ? (
            <ReasoningCard key={activity.id} activity={activity} />
          ) : (
            <PythonCard key={activity.id} activity={activity} />
          ),
        )}
      </div>
      {content && (
        <div className="message-bubble">
          <AssistantResponse content={content} />
        </div>
      )}
      {artifacts.length > 0 && (
        <div className="artifact-downloads" aria-label="Created files">
          {artifacts.map((artifact) => (
            <ArtifactDownload
              key={artifact.id}
              artifact={artifact}
              getAccessToken={getAccessToken}
            />
          ))}
        </div>
      )}
    </>
  );
}
