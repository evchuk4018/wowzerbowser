"use client";

import { useEffect, useState } from "react";
import type {
  ChatArtifact,
} from "../../lib/chat-protocol";
import { AssistantResponse } from "./assistant-response";
import type {
  AssistantActivity,
  PythonActivity,
  ReasoningActivity,
} from "./assistant-activity-types";
import { fetchChatArtifact } from "./chat-service";

export type {
  AssistantActivity,
  PythonActivity,
  ReasoningActivity,
} from "./assistant-activity-types";

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

type PythonSource = {
  filename: string;
  code: string;
};

function pythonSourceFor(activity: PythonActivity): PythonSource {
  try {
    const input = JSON.parse(activity.call.arguments) as { code?: unknown; file?: unknown };
    if (typeof input.file === "string" && input.file.trim()) {
      return { filename: input.file, code: `# Executed file: ${input.file}` };
    }
    if (typeof input.code === "string") return { filename: "script.py", code: input.code };
  } catch {
    // Keep malformed calls visible without allowing them to break the transcript.
  }
  return { filename: "script.py", code: "# Python source unavailable" };
}

type PythonToken = { text: string; className?: string };

function highlightPython(code: string): PythonToken[] {
  const tokenPattern = new RegExp("(#[^\\n]*|'''[\\s\\S]*?'''|\\\"\\\"\\\"[\\s\\S]*?\\\"\\\"\\\"|'(?:\\\\.|[^'\\\\])*'|\\\"(?:\\\\.|[^\\\"\\\\])*\\\"|\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\\b|\\b(?:print|len|range|str|int|float|list|dict|set|tuple|enumerate|zip|open|sum|min|max|sorted|super|self)\\b|\\b\\d+(?:\\.\\d+)?\\b|@[A-Za-z_][\\w.]*|==|!=|<=|>=|->|\\*\\*|//|[+\\-*%=<>:&|^~\\x2f])", "g");
  const tokens: PythonToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(code))) {
    if (match.index > lastIndex) tokens.push({ text: code.slice(lastIndex, match.index) });
    const value = match[0];
    const className = value.startsWith("#")
      ? "python-token-comment"
      : value.startsWith("\"") || value.startsWith("'")
        ? "python-token-string"
        : value.startsWith("@")
          ? "python-token-decorator"
          : /^\d/.test(value)
            ? "python-token-number"
            : /^(?:print|len|range|str|int|float|list|dict|set|tuple|enumerate|zip|open|sum|min|max|sorted|super|self)$/.test(value)
              ? "python-token-builtin"
              : /^[A-Za-z]/.test(value)
                ? "python-token-keyword"
                : "python-token-operator";
    tokens.push({ text: value, className });
    lastIndex = tokenPattern.lastIndex;
  }
  if (lastIndex < code.length) tokens.push({ text: code.slice(lastIndex) });
  return tokens;
}

function PythonCode({ activity }: { activity: PythonActivity }) {
  const source = pythonSourceFor(activity);
  return (
    <pre className="python-source" aria-label={`${source.filename} source code`}>
      <code>{highlightPython(source.code).map((token, index) => (
        <span key={`${index}-${token.text}`} className={token.className}>{token.text}</span>
      ))}</code>
    </pre>
  );
}

function PythonDisclosure({ activity }: { activity: PythonActivity }) {
  const [codeOpen, setCodeOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running");
  const duration = activity.durationMs ?? liveDuration;
  const statusLabel = activity.status === "running" ? "Running" : activity.status === "completed" ? "Completed" : "Failed";
  const source = pythonSourceFor(activity);
  const output = [activity.result?.stdout, activity.result?.stderr ? `stderr\n${activity.result.stderr}` : ""].filter(Boolean).join("\n");

  return (
    <div className={`python-nested python-nested-${activity.status}`}>
      <button type="button" className="python-nested-summary" aria-expanded={codeOpen} onClick={() => setCodeOpen((current) => !current)}>
        <span className="python-nested-chevron" aria-hidden="true">{codeOpen ? "⌄" : "›"}</span>
        <span className="python-nested-filename">{source.filename}</span>
        <span className="python-activity-status" aria-live="polite">{statusLabel}</span>
        {duration !== undefined && <span className="python-activity-duration">{formatDuration(duration)}</span>}
      </button>
      {codeOpen && <PythonCode activity={activity} />}
      <div className="python-output-divider" />
      <button type="button" className="python-output-summary" aria-expanded={outputOpen} onClick={() => setOutputOpen((current) => !current)}>
        <span className="python-nested-chevron" aria-hidden="true">{outputOpen ? "⌄" : "›"}</span>
        <span>Output</span>
      </button>
      {outputOpen && <pre className="python-output">{output || (activity.status === "running" ? "Waiting for output…" : "No output")}</pre>}
    </div>
  );
}

function ReasoningCard({ activity, pythonActivities }: { activity: ReasoningActivity; pythonActivities: PythonActivity[] }) {
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
      {open && (
        <div className="reasoning-content">
          <div>{activity.content}</div>
          {pythonActivities.length > 0 && (
            <div className="reasoning-python-list">
              {pythonActivities.map((python) => <PythonDisclosure key={python.id} activity={python} />)}
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
  const rounds = activities.reduce<Map<number, { reasoning?: ReasoningActivity; python: PythonActivity[] }>>((grouped, activity) => {
    const round = grouped.get(activity.round) ?? { python: [] };
    if (activity.kind === "reasoning") round.reasoning = round.reasoning
      ? { ...round.reasoning, content: `${round.reasoning.content}${activity.content}`, status: activity.status }
      : activity;
    else round.python.push(activity);
    grouped.set(activity.round, round);
    return grouped;
  }, new Map());

  return (
    <>
      <div className="assistant-activity-timeline">
        {[...rounds.entries()].map(([round, group]) => {
          const reasoning = group.reasoning ?? {
            id: `reasoning-${round}`,
            kind: "reasoning" as const,
            round,
            content: "",
            status: "complete" as const,
          };
          return <ReasoningCard key={reasoning.id} activity={reasoning} pythonActivities={group.python} />;
        })}
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
