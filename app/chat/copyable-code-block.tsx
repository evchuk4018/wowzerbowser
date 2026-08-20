"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

function textFromNode(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

type CopyableCodeBlockProps = React.HTMLAttributes<HTMLPreElement> & {
  node?: unknown;
};

export function CopyableCodeBlock({ children, node: _node, className, ...rest }: CopyableCodeBlockProps) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  const resetAfterDelay = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setState("idle"), 1600);
  }, []);

  const copy = useCallback(async () => {
    const text = textFromNode(children);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      resetAfterDelay();
    } catch {
      setState("error");
      resetAfterDelay();
    }
  }, [children, resetAfterDelay]);

  const label = state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy";
  const title = state === "idle" ? "Copy code" : label;

  return (
    <div className={`markdown-code-block${className ? ` ${className}` : ""}`} {...rest}>
      <pre>{children}</pre>
      <button
        type="button"
        className="markdown-code-copy"
        aria-label="Copy code"
        title={title}
        data-state={state}
        onClick={() => void copy()}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" className="markdown-code-copy-icon">
          <rect x="6.5" y="6.5" width="9" height="10" rx="1.5" />
          <path d="M13.5 6.5v-3h-9v10h2" />
        </svg>
        <span>{label}</span>
      </button>
    </div>
  );
}
