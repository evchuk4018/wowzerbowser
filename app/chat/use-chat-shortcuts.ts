"use client";

import { useEffect } from "react";

/** Register the global Ctrl/Cmd+K shortcut used to start a new conversation. */
export function useChatShortcuts(onNewChat: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;

    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onNewChat();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [enabled, onNewChat]);
}
