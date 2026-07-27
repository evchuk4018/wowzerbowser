"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatCitation, ChatSource } from "../../lib/chat-citations";
import { normalizeLatexDelimiters } from "./normalize-latex-delimiters";

const TOKEN = "\uE000citation:";
const TOKEN_END = "\uE001";

function addCitationTokens(content: string, annotations: readonly ChatCitation[], sources: readonly ChatSource[]): string {
  const known = new Set(sources.map((source) => source.id));
  const valid = annotations
    .map((annotation, index) => ({ annotation, index, ids: annotation.sourceIds.filter((id) => known.has(id)) }))
    .filter(({ annotation, ids }) => ids.length && annotation.end >= 0 && annotation.end <= content.length)
    .sort((left, right) => right.annotation.end - left.annotation.end);
  let result = content;
  for (const { annotation, index } of valid) result = `${result.slice(0, annotation.end)}${TOKEN}${index}${TOKEN_END}${result.slice(annotation.end)}`;
  return result;
}

function sourceLabel(source: ChatSource): string {
  return source.publisher || "Source";
}

function CitationBlob({ citation, sources, onOpen }: { citation: ChatCitation; sources: ChatSource[]; onOpen: (citation: ChatCitation) => void }) {
  const visibleSources = citation.sourceIds.map((id) => sources.find((source) => source.id === id)).filter((source): source is ChatSource => Boolean(source));
  if (!visibleSources.length) return null;
  return (
    <button type="button" className="citation-blob" onClick={() => onOpen(citation)} aria-label={`Open ${visibleSources.length} source${visibleSources.length === 1 ? "" : "s"}`}>
      <span className="citation-blob-dot" aria-hidden="true" />
      <span>{sourceLabel(visibleSources[0])}</span>
      {visibleSources.length > 1 && <span className="citation-blob-count">+{visibleSources.length - 1}</span>}
    </button>
  );
}

function SourceCard({ source }: { source: ChatSource }) {
  return (
    <article className="citation-source-card">
      <div className="citation-source-publisher"><span className="citation-source-dot" aria-hidden="true" />{source.publisher}</div>
      <h3>{source.title}</h3>
      {source.snippet && <p>{source.snippet}</p>}
      {source.publishedAt && <time>{source.publishedAt}</time>}
      <a href={source.url} target="_blank" rel="noreferrer">Open source <span aria-hidden="true">↗</span></a>
    </article>
  );
}

function CitationInspector({ citation, sources, onClose }: { citation: ChatCitation | null; sources: ChatSource[]; onClose: () => void }) {
  const startY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  useEffect(() => {
    if (!citation) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [citation, onClose]);
  if (!citation) return null;
  const selected = citation.sourceIds.map((id) => sources.find((source) => source.id === id)).filter((source): source is ChatSource => Boolean(source));
  if (!selected.length) return null;
  return (
    <>
      <button type="button" className="citation-scrim" aria-label="Close sources" onClick={onClose} />
      <aside className="citation-inspector" aria-label="Sources" aria-live="polite" style={{ transform: dragY ? `translateY(${dragY}px)` : undefined }} onPointerDown={(event) => { if (event.pointerType === "touch") startY.current = event.clientY; }} onPointerMove={(event) => { if (startY.current !== null) setDragY(Math.max(0, event.clientY - startY.current)); }} onPointerUp={() => { if (dragY > 80) onClose(); startY.current = null; setDragY(0); }} onPointerCancel={() => { startY.current = null; setDragY(0); }}>
        <div className="citation-sheet-handle" aria-hidden="true" />
        <div className="citation-inspector-header"><h2>{selected.length} Source{selected.length === 1 ? "" : "s"}</h2><button type="button" className="citation-close" onClick={onClose} aria-label="Close sources">×</button></div>
        <div className="citation-source-list">{selected.map((source) => <SourceCard key={source.id} source={source} />)}</div>
      </aside>
    </>
  );
}

function renderCitationChildren(children: React.ReactNode, annotations: ChatCitation[], sources: ChatSource[], onOpen: (citation: ChatCitation) => void): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child !== "string") {
      if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
        return React.cloneElement(child, { children: renderCitationChildren(child.props.children, annotations, sources, onOpen) });
      }
      return child;
    }
    const parts = child.split(new RegExp(`(${TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+${TOKEN_END})`));
    return parts.map((part, index) => {
      const match = part.match(new RegExp(`^${TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)${TOKEN_END}$`));
      if (!match) return part;
      const citation = annotations[Number(match[1])];
      return citation ? <CitationBlob key={`${match[1]}-${index}`} citation={citation} sources={sources} onOpen={onOpen} /> : null;
    });
  });
}

export function AssistantResponse({ content, annotations = [], sources = [] }: { content: string; annotations?: ChatCitation[]; sources?: ChatSource[] }) {
  const [selectedCitation, setSelectedCitation] = useState<ChatCitation | null>(null);
  const markedContent = useMemo(() => addCitationTokens(normalizeLatexDelimiters(content), annotations, sources), [annotations, content, sources]);
  const components = useMemo(() => {
    const wrap = (tag: keyof React.JSX.IntrinsicElements) => function CitationAwareElement({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) {
      return React.createElement(tag, props, renderCitationChildren(children, annotations, sources, setSelectedCitation));
    };
    return { p: wrap("p"), h1: wrap("h1"), h2: wrap("h2"), h3: wrap("h3"), h4: wrap("h4"), li: wrap("li"), blockquote: wrap("blockquote"), strong: wrap("strong"), em: wrap("em"), a: wrap("a"), td: wrap("td"), th: wrap("th") } as unknown as Components;
  }, [annotations, sources]);
  return (
    <>
      <div className="assistant-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>{markedContent}</ReactMarkdown>
      </div>
      <CitationInspector citation={selectedCitation} sources={sources} onClose={() => setSelectedCitation(null)} />
    </>
  );
}
