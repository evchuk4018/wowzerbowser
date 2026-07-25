"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatSettings } from "../chat/conversation-types";

export type SettingsModalProps = {
  settings: ChatSettings;
  onClose: () => void;
  onSave: (settings: ChatSettings) => void;
};

export function SettingsModal({ settings, onClose, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState(settings);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button, textarea"),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="settings-header">
          <div>
            <div className="settings-kicker">Preferences</div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>Ã—</button>
        </div>
        <label className="settings-field">
          <span>System prompt</span>
          <textarea value={settings.systemPrompt} readOnly aria-readonly="true" rows={7} />
        </label>
        <label className="settings-field">
          <span>User presence</span>
          <textarea
            value={draft.userPresence}
            maxLength={12000}
            onChange={(event) => setDraft((current) => ({ ...current, userPresence: event.target.value }))}
            rows={5}
            placeholder="Optional context about you"
          />
        </label>
        <div className="settings-actions">
          <button type="button" className="settings-cancel" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="settings-save"
            onClick={() => onSave({
              systemPrompt: settings.systemPrompt,
              userPresence: draft.userPresence.trim(),
            })}
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}
