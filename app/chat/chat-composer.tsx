"use client";

import type { Dispatch, FormEvent, KeyboardEvent, RefObject, SetStateAction } from "react";
import type { ChatModelId, ChatModelInfo, ChatReasoningEffort } from "../../lib/chat-protocol";

export type ChatComposerProps = {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  models: ChatModelInfo[];
  model: ChatModelId;
  setModel: Dispatch<SetStateAction<ChatModelId>>;
  selectedModel?: ChatModelInfo;
  openMenu: "model" | "thinking" | null;
  setOpenMenu: Dispatch<SetStateAction<"model" | "thinking" | null>>;
  thinking: boolean;
  setThinking: Dispatch<SetStateAction<boolean>>;
  effort: ChatReasoningEffort;
  setEffort: Dispatch<SetStateAction<ChatReasoningEffort>>;
  supportedEfforts: ChatReasoningEffort[];
  canThink: boolean;
  effectiveThinking: boolean;
  effectiveEffort: ChatReasoningEffort;
  editing: boolean;
  onCancelEdit: () => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
};

export function ChatComposer({
  draft,
  setDraft,
  textareaRef,
  isStreaming,
  models,
  model,
  setModel,
  selectedModel,
  openMenu,
  setOpenMenu,
  thinking,
  setThinking,
  effort,
  setEffort,
  supportedEfforts,
  canThink,
  effectiveThinking,
  effectiveEffort,
  editing,
  onCancelEdit,
  onSubmit,
  onKeyDown,
  onStop,
}: ChatComposerProps) {
  return (
    <form className="composer-wrap" onSubmit={(event) => void onSubmit(event)}>
      <div className="composer">
        {editing && (
          <div className="composer-editing">
            <span>Editing prompt</span>
            <button type="button" onClick={onCancelEdit}>Cancel</button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          aria-label="Message"
          placeholder="Message"
          disabled={isStreaming}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-actions">
          <button type="button" className="attach-button" aria-label="Attach a file" disabled={isStreaming}>+</button>
          <div className="composer-action-spacer" />
          <div className="composer-menu">
            <button
              type="button"
              className="composer-menu-trigger"
              aria-label="Choose model"
              aria-controls="model-options"
              aria-expanded={openMenu === "model"}
              disabled={isStreaming || !models.length}
              onClick={() => setOpenMenu((current) => (current === "model" ? null : "model"))}
            >
              <span className="menu-trigger-label">{selectedModel?.label ?? "Model"}</span>
              <span className="menu-chevron" aria-hidden="true">⌄</span>
            </button>
            {openMenu === "model" && (
              <div
                id="model-options"
                className="composer-menu-popover"
                role="group"
                aria-label="Models"
              >
                {models.map((availableModel) => (
                  <button
                    key={availableModel.id}
                    type="button"
                    aria-pressed={availableModel.id === model}
                    className={`composer-menu-option ${availableModel.id === model ? "selected" : ""}`}
                    disabled={isStreaming}
                    onClick={() => {
                      setModel(availableModel.id);
                      if (!availableModel.thinkingSupported || !availableModel.supportedEfforts.length) {
                        setThinking(false);
                      }
                      if (!availableModel.supportedEfforts.includes(effort)) {
                        setEffort(availableModel.supportedEfforts[0] ?? "high");
                      }
                      setOpenMenu(null);
                    }}
                  >
                    <span>{availableModel.label}</span>
                    {availableModel.id === model && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="composer-menu">
            <button
              type="button"
              className="composer-menu-trigger"
              aria-label="Choose thinking mode"
              aria-controls="thinking-options"
              aria-expanded={openMenu === "thinking"}
              disabled={isStreaming || !canThink}
              onClick={() => setOpenMenu((current) => (current === "thinking" ? null : "thinking"))}
            >
              <span className="menu-trigger-label">Thinking: {effectiveThinking ? effectiveEffort : "Off"}</span>
              <span className="menu-chevron" aria-hidden="true">⌄</span>
            </button>
            {openMenu === "thinking" && (
              <div
                id="thinking-options"
                className="composer-menu-popover"
                role="group"
                aria-label="Thinking mode"
              >
                <button
                  type="button"
                  aria-pressed={!thinking}
                  className={`composer-menu-option ${!thinking ? "selected" : ""}`}
                  disabled={isStreaming}
                  onClick={() => {
                    setThinking(false);
                    setOpenMenu(null);
                  }}
                >
                  <span>Off</span>
                  {!thinking && <span aria-hidden="true">✓</span>}
                </button>
                {supportedEfforts.map((supportedEffort) => (
                  <button
                    key={supportedEffort}
                    type="button"
                    aria-pressed={thinking && effort === supportedEffort}
                    className={`composer-menu-option ${thinking && effort === supportedEffort ? "selected" : ""}`}
                    disabled={isStreaming}
                    onClick={() => {
                      setThinking(true);
                      setEffort(supportedEffort);
                      setOpenMenu(null);
                    }}
                  >
                    <span>On · {supportedEffort[0].toUpperCase() + supportedEffort.slice(1)}</span>
                    {thinking && effort === supportedEffort && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {isStreaming ? (
            <button type="button" className="stop-button" onClick={onStop}>Stop</button>
          ) : (
            <button type="submit" className="send-button" aria-label="Send message" disabled={!draft.trim()}>↑</button>
          )}
        </div>
      </div>
      <p className="helper-text">Press Enter to send · Shift + Enter for a new line</p>
    </form>
  );
}
