"use client";

import { useState } from "react";
import type { Message } from "./conversation-types";
import { formatDuration } from "./format-duration";

export type ReasoningBlockProps = {
  message: Message;
  liveDurationMs?: number;
};

export function ReasoningBlock({ message, liveDurationMs }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false);
  const duration = message.thinkingDurationMs ?? liveDurationMs;
  const isThinking = message.status === "streaming" && !message.content;

  return (
    <div className={`reasoning-block ${open ? "reasoning-open" : ""}`}>
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-chevron" aria-hidden="true">â€º</span>
        <span>{isThinking ? "Thinking" : "Thought process"}</span>
        {duration !== undefined && <span className="reasoning-duration">{formatDuration(duration)}</span>}
      </button>
      {open && (
        <div className="reasoning-content">
          {message.reasoning}
        </div>
      )}
    </div>
  );
}
