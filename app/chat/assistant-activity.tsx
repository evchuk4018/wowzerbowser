"use client";

import { useEffect, useState } from "react";
import type {
  ChatArtifact,
} from "../../lib/chat-protocol";
import { AssistantResponse } from "./assistant-response";
import type {
  AssistantActivity,
  ImageActivity,
  PythonActivity,
  ReasoningActivity,
  WebActivity,
} from "./assistant-activity-types";
import { fetchChatArtifact } from "./chat-service";
import { formatDuration } from "./format-duration";
import type { ChatCitation, ChatSource } from "../../lib/chat-citations";

export type {
  AssistantActivity,
  PythonActivity,
  ReasoningActivity,
  WebActivity,
} from "./assistant-activity-types";

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

function WebDisclosure({ activity }: { activity: WebActivity }) {
  const [open, setOpen] = useState(false); const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running"); const duration = activity.durationMs ?? liveDuration;
  const web = activity.result?.web; const utility = activity.result?.utility;
  const label = web?.kind === "search" ? `Search: ${web.query}` : web?.kind === "page" ? `Page: ${web.source.url}` : utility?.kind === "time" ? `Time: ${utility.timeZone}` : utility?.kind === "date" ? `Date: ${utility.timeZone}` : utility?.kind === "location" ? "Deployment location" : activity.call.name === "web_search" ? "Web search" : activity.call.name === "fetch_page" ? "Fetch page" : activity.call.name;
  const output = web?.kind === "search" ? web.results.map((item) => `${item.title}\n${item.url}\n${item.snippet}`).join("\n\n") : web?.kind === "page" ? `${web.source.title}\n${web.source.url}\n\n${web.markdown}` : utility?.kind === "time" ? `${utility.currentTime}\n${utility.timeZone}` : utility?.kind === "date" ? `${utility.currentDate}\n${utility.timeZone}` : utility?.kind === "location" ? utility.available ? `${utility.location}\nSource: deployment metadata` : utility.message : activity.result?.stderr ?? "Waiting for result…";
  return <div className={`web-nested web-nested-${activity.status}`}><button type="button" className="web-nested-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span className="python-nested-chevron">{open ? "⌄" : "›"}</span><span className="web-activity-label">{label}</span><span className="python-activity-status">{activity.status === "running" ? "Running" : activity.status === "completed" ? "Completed" : "Failed"}</span>{duration !== undefined && <span className="python-activity-duration">{formatDuration(duration)}</span>}</button>{open && <pre className="web-output">{output}</pre>}</div>;
}
function ImageDisclosure({ activity }: { activity: ImageActivity }) {
  const [open, setOpen] = useState(false);
  const image = activity.result?.image;
  return (
    <div className={`image-nested image-nested-${activity.status}`}>
      <button type="button" className="web-nested-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="python-nested-chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>
        <span className="web-activity-label">Inspected image</span>
        <span className="python-activity-status">{activity.status === "running" ? "Running" : activity.status === "completed" ? "Completed" : "Failed"}</span>
      </button>
      {open && (
        <div className="image-output">
          <p><strong>Question:</strong> {image?.question ?? "Waiting for question…"}</p>
          <p><strong>Result:</strong> {image?.answer ?? activity.result?.stderr ?? "Waiting for result…"}</p>
        </div>
      )}
    </div>
  );
}
function ReasoningCard({ activity, pythonActivities, webActivities, imageActivities }: { activity: ReasoningActivity; pythonActivities: PythonActivity[]; webActivities: WebActivity[]; imageActivities: ImageActivity[] }) {
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
          {webActivities.map((web) => <WebDisclosure key={web.id} activity={web} />)}
          {imageActivities.map((image) => <ImageDisclosure key={image.id} activity={image} />)}
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
  annotations,
  sources,
  getAccessToken,
}: {
  activities: AssistantActivity[];
  content: string;
  artifacts: ChatArtifact[];
  annotations?: ChatCitation[];
  sources?: ChatSource[];
  getAccessToken: () => Promise<string | null>;
}) {
  const rounds = activities.reduce<Map<number, { reasoning?: ReasoningActivity; python: PythonActivity[]; web: WebActivity[]; image: ImageActivity[] }>>((grouped, activity) => {
    const round = grouped.get(activity.round) ?? { python: [], web: [], image: [] };
    if (activity.kind === "reasoning") round.reasoning = round.reasoning
      ? { ...round.reasoning, content: `${round.reasoning.content}${activity.content}`, status: activity.status }
      : activity;
    else if (activity.kind === "python") round.python.push(activity);
    else if (activity.kind === "web") round.web.push(activity);
    else round.image.push(activity);
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
          return <ReasoningCard key={reasoning.id} activity={reasoning} pythonActivities={group.python} webActivities={group.web} imageActivities={group.image} />;
        })}
      </div>
      {content && (
        <div className="message-bubble">
          <AssistantResponse content={content} annotations={annotations} sources={sources} />
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
