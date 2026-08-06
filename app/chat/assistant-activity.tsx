"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ChatArtifact,
} from "../../lib/chat-protocol";
import { AssistantResponse } from "./assistant-response";
import type {
  AssistantActivity,
  ImageActivity,
  PythonActivity,
  OutputActivity,
  ReasoningActivity,
  WebActivity,
  PhaseBreakActivity,
} from "./assistant-activity-types";
import { DocumentEditActivity } from "./document-edit-activity";
import { fetchChatArtifact } from "./chat-service";
import { formatDuration } from "./format-duration";
import type { ChatCitation, ChatSource } from "../../lib/chat-citations";
import { SubagentDisclosure, type SubagentActivity } from "./subagent-activity";

export type {
  AssistantActivity,
  PythonActivity,
  OutputActivity,
  ReasoningActivity,
  WebActivity,
  DocumentActivity,
  PhaseBreakActivity,
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

const DEEP_RESEARCH_ORCHESTRATOR_ID = "deep-research-orchestrator";

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
type RenderableActivity = AssistantActivity | SubagentActivity;

function ReasoningCard({
  activity,
  phaseActivities,
  autoOpen = false,
}: {
  activity: ReasoningActivity;
  phaseActivities: RenderableActivity[];
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const liveDuration = useLiveDuration(activity.startedAt, activity.status === "running");
  const duration = activity.durationMs ?? liveDuration;
  const subagents = phaseActivities.filter((item): item is SubagentActivity => item.kind === "subagent");

  return (
    <section className={`reasoning-block ${open ? "reasoning-open" : ""}`}>
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-chevron" aria-hidden="true">›</span>
        <span>{activity.summary ?? "Thinking…"}</span>
        {duration !== undefined && (
          <span className="reasoning-duration">{formatDuration(duration)}</span>
        )}
      </button>
      {open && (
        <div className="reasoning-content">
          {phaseActivities.map((item) => {
            if (item.kind === "reasoning") return <div key={item.id}>{item.content}</div>;
            if (item.kind === "python") return <div className="reasoning-python-list" key={item.id}><PythonDisclosure activity={item} /></div>;
            if (item.kind === "web") return <WebDisclosure key={item.id} activity={item} />;
            if (item.kind === "image") return <ImageDisclosure key={item.id} activity={item} />;
            if (item.kind === "document") return <DocumentEditActivity key={item.id} activity={item} />;
            return null;
          })}
        </div>
      )}
      {subagents.length > 0 && (
        <div className="reasoning-subagent-list" aria-label="Deep research agents">
          {subagents.map((item) => <SubagentDisclosure key={item.id} activity={item} />)}
        </div>
      )}
    </section>
  );
}

function ResearchActivityDisclosure({
  activity,
  subagents,
  streaming,
  children,
}: {
  activity: ReasoningActivity;
  subagents: SubagentActivity[];
  streaming: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(streaming);
  const previousStreaming = useRef(streaming);
  const completedSubagents = subagents.filter((item) => item.status === "completed").length;
  const status = streaming ? "Working" : "Complete";

  useEffect(() => {
    if (previousStreaming.current && !streaming) setOpen(false);
    if (!previousStreaming.current && streaming) setOpen(true);
    previousStreaming.current = streaming;
  }, [streaming]);

  return (
    <section className={`research-activity ${open ? "research-activity-open" : ""}`}>
      <button
        type="button"
        className="research-activity-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-chevron" aria-hidden="true">â€º</span>
        <span className="research-activity-heading">
          <span className="research-activity-title">Deep research</span>
          <span className="research-activity-current">{activity.summary ?? "Coordinating research"}</span>
        </span>
        <span className={`research-activity-status research-activity-status-${streaming ? "running" : "complete"}`} role="status" aria-live="polite">{status}</span>
        {subagents.length > 0 && <span className="research-activity-count">{completedSubagents}/{subagents.length} agents</span>}
      </button>
      {open && <div className="research-activity-details">{children}</div>}
    </section>
  );
}

function OutputBubble({
  activity,
  annotations,
  sources,
  artifacts,
  onOpenArtifact,
  streaming,
}: {
  activity: OutputActivity;
  annotations?: ChatCitation[];
  sources?: ChatSource[];
  artifacts: ChatArtifact[];
  onOpenArtifact: (artifact: ChatArtifact) => void;
  streaming: boolean;
}) {
  return (
    <div className="message-bubble assistant-activity-output">
      <AssistantResponse
        content={activity.content}
        annotations={annotations}
        sources={sources}
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
        streaming={streaming}
      />
    </div>
  );
}

type PhaseSegment =
  | { kind: "reasoning"; activities: RenderableActivity[] }
  | { kind: "output"; activity: OutputActivity };

function phaseSegments(activities: RenderableActivity[]): PhaseSegment[] {
  const segments: PhaseSegment[] = [];
  let reasoningActivities: RenderableActivity[] = [];
  const flushReasoning = () => {
    if (reasoningActivities.length) segments.push({ kind: "reasoning", activities: reasoningActivities });
    reasoningActivities = [];
  };

  for (const activity of activities) {
    if (activity.kind === "output") {
      flushReasoning();
      segments.push({ kind: "output", activity });
    } else if (activity.kind !== "phase_break") {
      reasoningActivities.push(activity);
    }
  }
  flushReasoning();
  return segments;
}

function reasoningForActivities(phase: number, activities: RenderableActivity[]): ReasoningActivity {
  const reasoningItems = activities.filter((item): item is ReasoningActivity => item.kind === "reasoning");
  const latestReasoning = reasoningItems.at(-1);
  const latestSummary = reasoningItems.reduce<ReasoningActivity | undefined>((current, item) => {
    if (!item.summary) return current;
    return !current || (item.summaryRevision ?? -1) >= (current.summaryRevision ?? -1)
      ? item
      : current;
  }, undefined);
  const completedDuration = reasoningItems.reduce((total, item) => total + (item.durationMs ?? 0), 0);
  if (!latestReasoning) {
    return {
      id: `reasoning-phase-${phase}`,
      kind: "reasoning",
      round: 1,
      phase,
      content: "",
      status: "complete",
    };
  }
  return {
    ...latestReasoning,
    ...(latestSummary
      ? { summary: latestSummary.summary, summaryRevision: latestSummary.summaryRevision }
      : {}),
    content: reasoningItems.map((item) => item.content).join(""),
    startedAt: reasoningItems[0]?.startedAt,
    ...(latestReasoning.status === "running"
      ? { durationMs: undefined }
      : completedDuration > 0 ? { durationMs: completedDuration } : { durationMs: undefined }),
  };
}

function annotationsForOutput(
  annotations: ChatCitation[] | undefined,
  start: number,
  length: number,
): ChatCitation[] | undefined {
  if (!annotations?.length) return annotations;
  const end = start + length;
  return annotations.flatMap((annotation) => {
    if (annotation.end <= start || annotation.end > end) return [];
    return [{
      ...annotation,
      start: Math.max(0, annotation.start - start),
      end: annotation.end - start,
    }];
  });
}

function ArtifactDownload({
  artifact,
  hasSession,
  onOpenArtifact,
}: {
  artifact: ChatArtifact;
  hasSession: () => Promise<boolean>;
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  const [state, setState] = useState<"idle" | "downloading" | "error">("idle");

  const download = async () => {
    if (state === "downloading") return;
    setState("downloading");
    try {
      if (!(await hasSession())) throw new Error("Session expired");
      const blob = await fetchChatArtifact(artifact);
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
  const isPdf = artifact.contentType === "application/pdf";

  return (
    <div className="artifact-download">
      <button
        type="button"
        disabled={!isPdf && state === "downloading"}
        onClick={() => isPdf ? onOpenArtifact(artifact) : void download()}
      >
        Created {artifact.name}
      </button>
      <span className="artifact-download-state" role="status" aria-live="polite">
        {state === "downloading" ? "Downloading…" : state === "error" ? "Download failed. Try again." : ""}
      </span>
    </div>
  );
}

type AssistantActivityTimelineProps = {
  activities: AssistantActivity[];
  content: string;
  artifacts: ChatArtifact[];
  annotations?: ChatCitation[];
  sources?: ChatSource[];
  hasSession: () => Promise<boolean>;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  streaming?: boolean;
};

function AssistantActivityTimelineInner({
  activities,
  content,
  artifacts,
  annotations,
  sources,
  hasSession,
  onOpenArtifact,
  streaming = false,
}: AssistantActivityTimelineProps) {
  const phases = activities.reduce<Map<number, { activities: RenderableActivity[]; phaseBreak?: PhaseBreakActivity }>>((grouped, activity) => {
    const phase = grouped.get(activity.phase) ?? { activities: [] };
    phase.activities.push(activity);
    if (activity.kind === "phase_break") phase.phaseBreak = activity;
    grouped.set(activity.phase, phase);
    return grouped;
  }, new Map());
  const outputActivities = activities.filter((activity): activity is OutputActivity => activity.kind === "output");
  const outputOffsets = new Map<string, number>();
  let outputOffset = 0;
  for (const activity of outputActivities) {
    outputOffsets.set(activity.id, outputOffset);
    outputOffset += activity.content.length;
  }
  const lastOutputId = outputActivities.at(-1)?.id;

  return (
    <>
      <div className="assistant-activity-timeline">
        {[...phases.entries()].map(([phase, group]) => {
          const segments = phaseSegments(group.activities);
          return (
            <div className="reasoning-phase" data-phase={phase} key={`phase-${phase}`}>
              {segments.map((segment) => {
                if (segment.kind === "output") {
                  return (
                    <OutputBubble
                      key={segment.activity.id}
                      activity={segment.activity}
                      annotations={annotationsForOutput(annotations, outputOffsets.get(segment.activity.id) ?? 0, segment.activity.content.length)}
                      sources={sources}
                      artifacts={artifacts}
                      onOpenArtifact={onOpenArtifact}
                      streaming={streaming && segment.activity.id === lastOutputId}
                    />
                  );
                }

                const activity = reasoningForActivities(phase, segment.activities);
                const subagents = segment.activities.filter((item): item is SubagentActivity => item.kind === "subagent");
                const isDeepResearch = subagents.length > 0
                  || segment.activities.some((item) => item.kind === "reasoning" && item.id === DEEP_RESEARCH_ORCHESTRATOR_ID);
                const card = (
                  <ReasoningCard
                    key={`reasoning-${segment.activities[0]?.id ?? phase}`}
                    activity={activity}
                    phaseActivities={segment.activities}
                    autoOpen={isDeepResearch && streaming}
                  />
                );
                if (!isDeepResearch) return card;
                return (
                  <ResearchActivityDisclosure
                    key={`research-${segment.activities[0]?.id ?? phase}`}
                    activity={activity}
                    subagents={subagents}
                    streaming={streaming}
                  >
                    {card}
                  </ResearchActivityDisclosure>
                );
              })}
              {group.phaseBreak?.update && (
                <div className="message-bubble phase-progress-update" role="status" aria-label="Progress update">
                  <span className="phase-progress-update-label">Progress update</span>
                  <span>{group.phaseBreak.update}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {content && !outputActivities.length && (
        <div className="message-bubble">
          <AssistantResponse
            content={content}
            annotations={annotations}
            sources={sources}
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
            streaming={streaming}
          />
        </div>
      )}
      {artifacts.length > 0 && (
        <div className="artifact-downloads" aria-label="Created files">
          {artifacts.map((artifact) => (
            <ArtifactDownload
              key={artifact.id}
              artifact={artifact}
              hasSession={hasSession}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </div>
      )}
    </>
  );
}

export const AssistantActivityTimeline = memo(AssistantActivityTimelineInner);
