"use client";

import { useEffect, useRef } from "react";

export type DeleteConfirmationDialogProps = {
  conversationTitle: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmationDialog({
  conversationTitle,
  pending,
  error,
  onCancel,
  onConfirm,
}: DeleteConfirmationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
      );
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
  }, [onCancel, pending]);

  return (
    <div
      className="delete-dialog-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (!pending && event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-description"
        aria-busy={pending}
      >
        <div className="delete-dialog-kicker">Delete conversation</div>
        <h2 id="delete-dialog-title">Are you sure?</h2>
        <p id="delete-dialog-description">
          Delete <strong>{conversationTitle}</strong>? This cannot be undone.
        </p>
        {error && <div className="delete-dialog-error" role="alert">{error}</div>}
        <div className="delete-dialog-actions">
          <button type="button" className="delete-dialog-cancel" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="delete-dialog-confirm" disabled={pending} onClick={onConfirm}>
            {pending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </section>
    </div>
  );
}
